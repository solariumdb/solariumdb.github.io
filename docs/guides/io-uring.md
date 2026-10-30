---
sidebar_position: 7
---

# io_uring on Linux

On Linux 6.1 or later, the `SolariumDb.IoUring` package lets the engine do its file writes through io_uring, the asynchronous I/O interface of the Linux kernel, on the [ioxide](https://github.com/MDA2AV/ioxide) runtime. Its clear gain is `MultiGet` from the drive: the reads that the page cache misses are in flight together. On the `large` Kahuna dataset under a memory limit, `MultiGet` read 2.5 times as many keys from one thread as on the default storage environment, and 1.6 times from eight. Other reads match the default storage environment, and unsynced writes are slower. Use it only when your own measurements show a gain.

All file I/O in Solarium goes through a **storage environment**, as with the `Env` of RocksDB. The default storage environment works on every platform. `Solarium.IoUring` adds a second one.

## Use the io_uring storage environment

```csharp
using Solarium;
using Solarium.IoUring;

if (!IoUringStorageEnvironment.IsSupported())
    throw new PlatformNotSupportedException("io_uring is not available.");

using IoUringStorageEnvironment environment = new();   // dispose after every database that uses it
using SolariumDb db = SolariumDb.Open("./data", new DbOptions { Environment = environment });
```

The host owns the environment:

- Create it before the databases that use it.
- Dispose it after every database that uses it is closed.
- One environment can serve several databases.

The constructor takes the size of the ring, `ringEntries`. The default is 256.

## How it works

| Environment | Writes | Reads | Batch reads (`MultiGet`) | Flush |
| --- | --- | --- | --- | --- |
| `DefaultStorageEnvironment` (all platforms) | `RandomAccess` (pwrite) | `RandomAccess` (pread) | One read after the other | `RandomAccess.FlushToDisk` |
| `IoUringStorageEnvironment` (Linux) | `IORING_OP_WRITE` on one ioxide reactor thread | `pread` on the calling thread | `preadv2(RWF_NOWAIT)` on the calling thread, then the ring for what the page cache misses | `fdatasync` on the calling thread |

ioxide has no fsync operation in its API. So the io_uring storage environment flushes with `fdatasync` on the calling thread, not through the ring.

A table read is one blocking read, usually from the page cache. Through the ring, the reads of every thread ran one at a time on the reactor thread, at about half the rate of the default environment. So reads use `pread` on the calling thread. A batch read is different: the reads that miss the page cache go to the ring together, and the drive serves them at once.

## What io_uring costs

Every write is a hand-off to the reactor thread, and the hand-off costs more than the system call that it replaces. Measured on Linux 6.12 with ext4 on an NVMe drive, on 2026-10-29:

| Operation | Default | io_uring |
| --- | ---: | ---: |
| 4 KB read | 344 ns | 333 ns |
| 4 KB write | 0.93 µs | 6.33 µs |
| 64 KB write | 13.8 µs | 21.7 µs |
| Unsynced `Put` from one thread | 934 ns | 5,988 ns |
| Synced `Put` | within 4% | within 4% |

On Linux 6.1, io_uring could not complete a buffered ext4 write inline. It passes the write to one of its worker threads (`iou-wrk`), and the extra cost grows with the size of the write. A synced `Put` costs the same in both environments, because the device flush takes milliseconds and neither environment sends it through the ring.

Reads on the calling thread have a cost too. Where readers keep every CPU busy, a write waits for the reactor thread to get a CPU. With six readers in a tight loop beside one writer on four CPUs, the writer flushed about a fifth of the tables that it flushed on the default environment.

[Storage Environments](../architecture/storage-environments.md#reads-on-the-calling-thread) gives the read measurements.

## Cancelled operations

The ring can complete a write with `ECANCELED`. Then the environment does the write again with `pwrite` on the calling thread, and counts it in `IoUringStorageEnvironment.CanceledOperations`.

The retry is safe whatever the cause, because a positional write at the same offset leaves the same bytes. Without it, a cancelled WAL write would stop the writes of the database until it opens again. The exact cause of the `ECANCELED` is not confirmed.

## Run io_uring in Docker

Docker blocks io_uring by default. A container needs two flags:

```shell
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 <image>
```

- `--security-opt seccomp=unconfined`: the default seccomp profile of Docker blocks io_uring.
- `--ulimit memlock=-1`: each ring counts against the locked-memory limit.

## With Kommander

`SolariumWAL` takes the environment through its options. See [Solarium.Kommander](../integrations/kommander.md#io_uring).
