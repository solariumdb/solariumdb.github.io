---
sidebar_position: 10
---

# Storage Environments

All file I/O of Solarium goes through a **storage environment**, as with the `Env` and `FileSystem` of RocksDB. The engine never opens, deletes, or renames a file directly, except for the `LOCK` file. This makes three things possible: a portable default, an io_uring storage environment for Linux, and test environments that simulate a power loss.

## The interfaces

The interface `IStorageEnvironment` is in the namespace `Solarium.Storage`.

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `string Name` | A short name, for diagnostics and test names. | |
| `IStorageFile OpenFile(string path)` | Opens a file for reading and writing. Creates it if it does not exist. | |
| `void MultiRead(Span<ReadRequest> requests)` | Reads a batch of requests, across files. It sets the `BytesRead` of each request. An environment can keep the reads in flight together. | `FSRandomAccessFile::MultiRead`, but one batch spans files |
| `bool FileExists(string path)` | True when the path names a file. | `FileExists` |
| `string[] GetChildren(string directory)` | The names of the entries of a directory. | `GetChildren` |
| `void DeleteFile(string path)` | Deletes a file if it exists. | `DeleteFile` |
| `void RenameFile(string source, string target)` | Renames a file, and replaces the target atomically when it exists. | `RenameFile` |
| `bool TryLinkFile(string source, string target)` | Makes a hard link. Returns false when the file system cannot link the two paths. | `LinkFile`, with `NotSupported` |
| `void CreateDirectory(string directory)` | Creates a directory and its missing parents. | |
| `void FlushDirectory(string directory)` | Makes the entries of a directory durable (an fsync of the directory). | `FSDirectory::Fsync` |

A deleted, renamed, linked, or created entry is durable only after `FlushDirectory` of its directory.

All members except `Name` and `OpenFile` have default implementations, on the file APIs of .NET, and on libc or Win32 for the link and the directory fsync. The default `MultiRead` reads the requests one after another through `IStorageFile.Read`. An environment overrides them to observe or change them.

`IStorageFile` is one open file: positional `Read` and `Write`, `Flush`, `SyncRange`, `GetLength`, `SetLength`, and `Dispose`.

`SyncRange(offset, length)` starts the writeback of a range to the device and does not wait for it, as the `RangeSync` of RocksDB. It does not make the range durable. A flush or a compaction calls it every `BytesPerSync` bytes of an SSTable. The default implementation is empty. Both environments call `sync_file_range(SYNC_FILE_RANGE_WRITE)` on Linux. The reactor does not have such an operation, and the io_uring storage environment makes the call on the calling thread. On other platforms, the call does nothing.

## The environments

| Environment | Reads and writes | Flush |
| --- | --- | --- |
| `DefaultStorageEnvironment` (all platforms) | `RandomAccess` (pread and pwrite) | `fdatasync` on Linux. `RandomAccess.FlushToDisk` elsewhere: `F_FULLFSYNC` on macOS, `FlushFileBuffers` on Windows. |
| `IoUringStorageEnvironment` (Linux, in `Solarium.IoUring`) | Writes: `IORING_OP_WRITE` on one ioxide reactor thread. Reads: `pread` on the calling thread. Batch reads: `preadv2(RWF_NOWAIT)` on the calling thread, then `IORING_OP_READ` for what the page cache misses. | `fdatasync` on the calling thread |

On Linux, both storage environments flush with `fdatasync`, as RocksDB does by default. It makes the data and the length durable, and skips the journal commit that a changed timestamp alone needs with `fsync`. A write in place over allocated blocks, such as a slot of the sync ledger of Kommander, would otherwise pay for that commit in its flush.

The host owns an environment, and disposes it after all the databases that use it are closed. `DefaultStorageEnvironment.Instance` is shared and needs no dispose.

## io_uring performance

The engine issues one write at a time. In the io_uring storage environment, a write is a hand-off to the reactor thread, and the hand-off costs more than the system call that it replaces. These results are from ext4 on an NVMe drive.

- On Linux 6.1, a 4 KB read from the page cache took 2.6 µs through the ring and 0.4 µs with `pread`. The kernel completes it inline, and the extra cost is the hand-off alone, about 2.3 µs.
- On Linux 6.12 on 2026-10-29, a 4 KB write took 6.33 µs with io_uring and 0.93 µs with the default environment. A 64 KB write took 21.7 µs and 13.8 µs. On Linux 6.1, io_uring could not complete a buffered ext4 write inline. It passes the write to one of its worker threads (`iou-wrk`), and the extra cost grows with the size of the write.
- A synced `Put` costs the same in both environments, because the device flush takes milliseconds and neither environment sends it through the ring.

io_uring is faster only when many operations are in flight at once.

### Reads on the calling thread

A table read is one blocking read, usually from the page cache. Through the ring, the reads of all threads ran one at a time on the reactor thread. For this reason, the io_uring storage environment reads with `pread` on the calling thread. The table gives operations per second on the `large` Kahuna dataset (2,000,000 rows of 1 KiB, Linux 6.12, ext4 on NVMe, one repeat).

| Case | Default | io_uring, reads on the ring | io_uring, reads with `pread` |
| --- | ---: | ---: | ---: |
| get, 1 thread | 278,806 | 142,851 | 289,846 |
| get, 8 threads | 1,249,720 | 504,846 | 1,177,798 |
| get-batch16, 8 threads | 1,174,790 | 515,716 | 1,276,174 |
| drain after the load | 12 s | 26 s | 14 s |

The drain is the compactions that the load left behind. Their input reads went through the ring too.

Reads on the calling thread can slow down writes. Where readers keep all the CPUs busy, a write waits for the reactor thread to get a CPU. In a test with six readers in a tight loop beside one writer on four CPUs, the writer flushed 151 to 166 tables in 3 seconds on io_uring. It flushed 390 with reads on the ring, and 700 to 970 on the default environment.

### Batch reads

`MultiRead` reads a batch of requests, across files, for `MultiGet`.

1. The io_uring storage environment first reads what is in the page cache, on the calling thread, with `preadv2(RWF_NOWAIT)`. That call does not wait for the drive, and returns `EAGAIN` for the rest.
2. It sends the rest to the ring together, and waits for all of them. The drive then serves them at once, where `pread` waits for each in turn.

Reads from the page cache do not use the ring. A file system without `RWF_NOWAIT`, such as tmpfs, is read with `pread`. Cold random reads of 4 KiB from the NVMe drive above, in batches of 16, made 8,300 to 10,200 reads per second from one thread with `pread`, and 60,000 to 65,600 through the ring. From 8 threads, they made 133,000 to 135,000 with `pread`, and 147,000 to 153,000 through the ring. There, the drive is near its limit either way.

The next table gives keys per second for `MultiGet` on the `large` Kahuna dataset, with 16 keys for each call. The memory limit was 2 GiB, where blocks come from the drive (one repeat).

| Case | Default, before | Default, after | io_uring, before | io_uring, after |
| --- | ---: | ---: | ---: | ---: |
| 1 thread | 40,757 | 41,529 | 43,503 | 104,353 |
| 8 threads | 271,074 | 277,956 | 277,763 | 450,378 |

Before, `MultiGet` read the block of each key with a separate `pread`. From the drive, io_uring now reads 2.4 times as many keys from one thread, and 1.6 times from eight. The p99 of a call from one thread fell from 1,065 µs to 397 µs. In the page cache, io_uring pays 3% to 5% for the `preadv2` and the batch, and the default environment is unchanged.

## Cancelled operations

A write that the ring completes with `ECANCELED` is done again with `pwrite` on the calling thread, and counted in `IoUringStorageEnvironment.CanceledOperations`.

The kernel reports `ECANCELED` for io-wq work that did not run. One path on 6.1 is an io-wq that cannot start the first worker for a kind of work, which fails what it queued. It was seen once, on the first write of an `Open`, in a full parallel test run. A load of 205,000 new reactors that wrote new files did not show it again. The exact cause is not confirmed.

A retry on the calling thread is safe whatever the cause. A positional write done again at the same offset leaves the same bytes, and the retry does not depend on the reactor or io-wq.

## Test environments

The tests use environments that wrap a real one.

| Environment | What it does |
| --- | --- |
| `PowerLossEnvironment` | Records what each file and the directory held at their last flush. A crash writes out what a power loss can leave. Its `None` loss is a process crash, and every write and directory change survives it. |
| `HookedEnvironment` | Holds an operation at a chosen point, or injects a failure. |
| A recording environment | Records the order of durable operations, for example that `FORMAT` comes after `MANIFEST`. |

All file operations go through the environment, and these tests see each change to the directory. See [Testing](../operations/testing.md).

## Write your own

To put the files somewhere else, or to observe the I/O, implement `IStorageEnvironment` and pass it in `DbOptions.Environment`. The environment in this example counts the calls to `OpenFile`.

```csharp
using Solarium;
using Solarium.Storage;

sealed class CountingEnvironment(IStorageEnvironment inner) : IStorageEnvironment
{
    public long Opens;

    public string Name => $"counting ({inner.Name})";

    public IStorageFile OpenFile(string path)
    {
        Interlocked.Increment(ref Opens);
        return inner.OpenFile(path);
    }

    public void FlushDirectory(string directory) => inner.FlushDirectory(directory);
}

using SolariumDb db = SolariumDb.Open("./data",
    new DbOptions { Environment = new CountingEnvironment(DefaultStorageEnvironment.Instance) });
```

A flush must make the data durable on the device. An environment that does less breaks the durability of synced writes.
