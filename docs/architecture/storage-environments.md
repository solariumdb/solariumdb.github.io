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
| `bool FileExists(string path)` | True when the path names a file. | `FileExists` |
| `string[] GetChildren(string directory)` | The names of the entries of a directory. | `GetChildren` |
| `void DeleteFile(string path)` | Deletes a file. Nothing happens when it does not exist. | `DeleteFile` |
| `void RenameFile(string source, string target)` | Renames a file, and replaces the target atomically when it exists. | `RenameFile` |
| `bool TryLinkFile(string source, string target)` | Makes a hard link. Returns false when the file system cannot link the two paths. | `LinkFile`, with `NotSupported` |
| `void CreateDirectory(string directory)` | Creates a directory and its missing parents. | |
| `void FlushDirectory(string directory)` | Makes the entries of a directory durable (an fsync of the directory). | `FSDirectory::Fsync` |

A deleted, renamed, linked, or created entry is durable only after `FlushDirectory` of its directory.

All members except `Name` and `OpenFile` have default implementations, on the file APIs of .NET, and on libc or Win32 for the link and the directory fsync. An environment overrides them to observe or change them.

`IStorageFile` is one open file: positional `Read` and `Write`, `Flush`, `SyncRange`, `GetLength`, `SetLength`, and `Dispose`.

`SyncRange(offset, length)` starts the writeback of a range to the device and does not wait for it, as the `RangeSync` of RocksDB. It makes nothing durable. A flush or a compaction calls it every `BytesPerSync` bytes of an SSTable. Its default does nothing. Both environments call `sync_file_range(SYNC_FILE_RANGE_WRITE)` on Linux. The io_uring storage environment calls it on the calling thread, because the reactor has no such operation. Elsewhere, it does nothing.

## The environments

| Environment | Reads and writes | Flush |
| --- | --- | --- |
| `DefaultStorageEnvironment` (all platforms) | `RandomAccess` (pread and pwrite) | `RandomAccess.FlushToDisk` |
| `IoUringStorageEnvironment` (Linux, in `Solarium.IoUring`) | `IORING_OP_READ` and `IORING_OP_WRITE` on one ioxide reactor thread | `fdatasync` on the calling thread |

The host owns an environment, and disposes it after every database that uses it is closed. `DefaultStorageEnvironment.Instance` is shared and needs no dispose.

## Why io_uring is not faster here

The engine issues one operation at a time. Every read and write in the io_uring storage environment is a hand-off to the reactor thread, and the hand-off costs more than the system call that it replaces. Measured on Linux 6.1 with ext4 on an NVMe drive:

- A 4 KB read from the page cache takes 2.6 µs instead of 0.4 µs. The kernel completes it inline, so the extra cost is the hand-off alone, about 2.3 µs.
- A 4 KB write takes 6.9 µs instead of 1.5 µs, and a 64 KB write 29 µs instead of 20 µs. On this kernel, io_uring cannot complete a buffered ext4 write inline. It passes the write to one of its worker threads (`iou-wrk`), and the extra cost grows with the size of the write.
- A synced `Put` costs the same in both environments, because the device flush takes milliseconds and neither environment sends it through the ring.

io_uring can only win when many operations are in flight at once.

## Cancelled operations

A read or write that the ring completes with `ECANCELED` is done again with `pread` or `pwrite` on the calling thread, and counted in `IoUringStorageEnvironment.CanceledOperations`.

The kernel reports `ECANCELED` for io-wq work that never ran. One path on 6.1 is an io-wq that cannot start the first worker for a kind of work, which fails what it queued. It was seen once, on the first write of an `Open`, in a full parallel test run. A load of 205,000 new reactors that wrote new files did not show it again, so the exact cause is not confirmed.

A retry on the calling thread is safe whatever the cause. Positional I/O written or read again at the same offset gives the same result, and the retry does not depend on the reactor or io-wq.

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
