---
sidebar_position: 10
---

# Storage Environments

All file I/O of Solarium goes through a **storage environment**, as with the `Env` and `FileSystem` of RocksDB. The engine never opens, deletes, or renames a file directly, except for the `LOCK` file. This makes three things possible: a portable default, an io_uring storage environment for Linux, and test environments that simulate a power loss.

## The interfaces

`IStorageEnvironment`, in the namespace `Solarium.Storage`:

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `string Name` | A short name, for diagnostics and test names. | |
| `IStorageFile OpenFile(string path)` | Opens a file for reading and writing. Creates it if it does not exist. | |
| `void MultiRead(Span<ReadRequest> requests)` | Reads every request of a batch, across files, and sets its `BytesRead`. An environment can keep the reads in flight together. | `FSRandomAccessFile::MultiRead`, but one batch spans files |
| `bool FileExists(string path)` | True when the path names a file. | `FileExists` |
| `string[] GetChildren(string directory)` | The names of the entries of a directory. | `GetChildren` |
| `void DeleteFile(string path)` | Deletes a file. Nothing happens when it does not exist. | `DeleteFile` |
| `void RenameFile(string source, string target)` | Renames a file, and replaces the target atomically when it exists. | `RenameFile` |
| `bool TryLinkFile(string source, string target)` | Makes a hard link. Returns false when the file system cannot link the two paths. | `LinkFile`, with `NotSupported` |
| `void CreateDirectory(string directory)` | Creates a directory and its missing parents. | |
| `void FlushDirectory(string directory)` | Makes the entries of a directory durable (an fsync of the directory). | `FSDirectory::Fsync` |

A deleted, renamed, linked, or created entry is durable only after `FlushDirectory` of its directory.

All members except `Name` and `OpenFile` have default implementations, on the file APIs of .NET, and on libc or Win32 for the link and the directory fsync. The default `MultiRead` reads the requests one after another through `IStorageFile.Read`. An environment overrides them to observe or change them.

`IStorageFile` is one open file: positional `Read` and `Write`, `Flush`, `SyncRange`, `GetLength`, `SetLength`, and `Dispose`.

`SyncRange(offset, length)` starts the writeback of a range to the device and does not wait for it, as the `RangeSync` of RocksDB. It makes nothing durable. A flush or a compaction calls it every `BytesPerSync` bytes of an SSTable. Its default does nothing. Both environments call `sync_file_range(SYNC_FILE_RANGE_WRITE)` on Linux. The io_uring storage environment calls it on the calling thread, because the reactor has no such operation. Elsewhere, it does nothing.

## The environments

| Environment | Reads and writes | Flush |
| --- | --- | --- |
| `DefaultStorageEnvironment` (all platforms) | `RandomAccess` (pread and pwrite) | `RandomAccess.FlushToDisk` |
| `IoUringStorageEnvironment` (Linux, in `Solarium.IoUring`) | Writes: `IORING_OP_WRITE` on one ioxide reactor thread. Reads: `pread` on the calling thread. Batch reads: `preadv2(RWF_NOWAIT)` on the calling thread, then `IORING_OP_READ` for what the page cache misses. | `fdatasync` on the calling thread |

The host owns an environment, and disposes it after every database that uses it is closed. `DefaultStorageEnvironment.Instance` is shared and needs no dispose.

## Why io_uring is not faster here

The engine issues one write at a time. Every write in the io_uring storage environment is a hand-off to the reactor thread, and the hand-off costs more than the system call that it replaces. Measured on Linux 6.1 with ext4 on an NVMe drive:

- A 4 KB read from the page cache took 2.6 µs through the ring instead of 0.4 µs with `pread`. The kernel completes it inline, so the extra cost is the hand-off alone, about 2.3 µs.
- A 4 KB write takes 6.9 µs instead of 1.5 µs, and a 64 KB write 29 µs instead of 20 µs. On this kernel, io_uring cannot complete a buffered ext4 write inline. It passes the write to one of its worker threads (`iou-wrk`), and the extra cost grows with the size of the write.
- A synced `Put` costs the same in both environments, because the device flush takes milliseconds and neither environment sends it through the ring.

io_uring can only win when many operations are in flight at once.

### Reads on the calling thread

A table read is one blocking read, usually from the page cache. Through the ring, the reads of every thread ran one at a time on the reactor thread. So the io_uring storage environment reads with `pread` on the calling thread. On the `large` Kahuna dataset (2,000,000 rows of 1 KiB, Linux 6.12, ext4 on NVMe, one repeat), in operations per second:

| Case | Default | io_uring, reads on the ring | io_uring, reads with `pread` |
| --- | ---: | ---: | ---: |
| get, 1 thread | 278,806 | 142,851 | 289,846 |
| get, 8 threads | 1,249,720 | 504,846 | 1,177,798 |
| get-batch16, 8 threads | 1,174,790 | 515,716 | 1,276,174 |
| drain after the load | 12 s | 26 s | 14 s |

The drain is the compactions that the load left behind. Their input reads went through the ring too.

The cost: where readers keep every CPU busy, a write waits for the reactor thread to get a CPU. In a test with six readers in a tight loop beside one writer on four CPUs, the writer flushed 151 to 166 tables in 3 seconds on io_uring. With reads on the ring, it flushed 390, and on the default environment 700 to 970.

### Batch reads

`MultiRead` reads a batch of requests, across files, for `MultiGet`:

1. The io_uring storage environment first reads what the page cache holds, on the calling thread, with `preadv2(RWF_NOWAIT)`. That call fails with `EAGAIN` instead of a wait for the drive.
2. It sends the rest to the ring together, and waits for all of them. So the drive serves them at once, where `pread` waits for each in turn.

Reads that the page cache holds stay off the ring. A file system without `RWF_NOWAIT`, such as tmpfs, is read with `pread`. Cold random reads of 4 KiB from the NVMe drive above, in batches of 16, made 8,300 to 10,200 reads per second from one thread with `pread`, and 60,000 to 65,600 through the ring. From 8 threads, they made 133,000 to 135,000 with `pread`, and 147,000 to 153,000 through the ring. There, the drive is near its limit either way.

`MultiGet` on the `large` Kahuna dataset, 16 keys for each call, in keys per second. Under a memory limit of 2 GiB, where blocks come from the drive, one repeat:

| Case | Default, before | Default, after | io_uring, before | io_uring, after |
| --- | ---: | ---: | ---: | ---: |
| 1 thread | 40,757 | 41,529 | 43,503 | 104,353 |
| 8 threads | 271,074 | 277,956 | 277,763 | 450,378 |

Before, `MultiGet` read the block of each key with its own `pread`. From the drive, io_uring now reads 2.4 times as many keys from one thread, and 1.6 times from eight. The p99 of a call from one thread fell from 1,065 µs to 397 µs. In the page cache, io_uring pays 3% to 5% for the `preadv2` and the batch, and the default environment is unchanged.

## Cancelled operations

A write that the ring completes with `ECANCELED` is done again with `pwrite` on the calling thread, and counted in `IoUringStorageEnvironment.CanceledOperations`.

The kernel reports `ECANCELED` for io-wq work that never ran. One path on 6.1 is an io-wq that cannot start the first worker for a kind of work, which fails what it queued. It was seen once, on the first write of an `Open`, in a full parallel test run. A load of 205,000 new reactors that wrote new files did not show it again, so the exact cause is not confirmed.

A retry on the calling thread is safe whatever the cause. A positional write done again at the same offset leaves the same bytes, and the retry does not depend on the reactor or io-wq.

## Test environments

The tests use environments that wrap a real one:

| Environment | What it does |
| --- | --- |
| `PowerLossEnvironment` | Keeps what each file and the directory held at their last flush. A crash writes out what a power loss can leave. Its `None` loss is a process crash: it keeps every write and directory change. |
| `HookedEnvironment` | Holds an operation at a chosen point, or injects a failure. |
| A recording environment | Records the order of durable operations, for example that `FORMAT` comes after `MANIFEST`. |

Because every file operation goes through the environment, these tests see each change to the directory. See [Testing](../operations/testing.md).

## Write your own

To put the files somewhere else, or to observe the I/O, implement `IStorageEnvironment` and pass it in `DbOptions.Environment`:

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
