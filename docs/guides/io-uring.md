---
sidebar_position: 7
---

# io_uring on Linux

All file I/O in Solarium goes through a **storage environment**, as with the `Env` of RocksDB. The default environment works on every platform. The `Solarium.IoUring` package adds an environment for Linux 6.1 or later that does its file I/O through io_uring, on the [ioxide](https://github.com/MDA2AV/ioxide) runtime.

:::tip Measure first
On the measured hardware, io_uring is never faster for one operation at a time, which is how the engine issues them. Unsynced writes were 0.3 to 0.9 times as fast as RocksDB on io_uring, against 1.0 to 1.6 times on the default environment. Use the default environment unless your own measurements show a gain.
:::

## Use the io_uring environment

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

| Environment | Reads and writes | Flush |
| --- | --- | --- |
| `DefaultStorageEnvironment` (all platforms) | `RandomAccess` (pread and pwrite) | `RandomAccess.FlushToDisk` |
| `IoUringStorageEnvironment` (Linux) | `IORING_OP_READ` and `IORING_OP_WRITE` on one ioxide reactor thread | `fdatasync` on the calling thread |

ioxide has no fsync operation in its API. So the io_uring environment flushes with `fdatasync` on the calling thread, not through the ring.

## What io_uring costs

Every read and write is a hand-off to the reactor thread, and the hand-off costs more than the system call that it replaces. Measured on Linux 6.1 with ext4 on an NVMe drive:

| Operation | Default | io_uring |
| --- | ---: | ---: |
| 4 KB read from the page cache | 0.4 µs | 2.6 µs |
| 4 KB write | 1.5 µs | 6.9 µs |
| 64 KB write | 20 µs | 29 µs |
| Unsynced `Put` from one thread | 3.0 µs | 6.9 µs |
| Synced `Put` | the same | the same |

On this kernel, io_uring cannot complete a buffered ext4 write inline. It passes the write to one of its worker threads (`iou-wrk`), and the extra cost grows with the size of the write. A synced `Put` costs the same in both environments, because the device flush takes milliseconds and neither environment sends it through the ring.

## Cancelled operations

The ring can complete a read or a write with `ECANCELED`. Then the environment does the operation again with `pread` or `pwrite` on the calling thread, and counts it in `IoUringStorageEnvironment.CanceledOperations`.

The retry is safe whatever the cause, because positional I/O at the same offset gives the same result. Without it, a cancelled WAL write would stop the writes of the database until it opens again. The exact cause of the `ECANCELED` is not confirmed.

## Run io_uring in Docker

Docker blocks io_uring by default. A container needs two flags:

```shell
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 <image>
```

- `--security-opt seccomp=unconfined`: the default seccomp profile of Docker blocks io_uring.
- `--ulimit memlock=-1`: each ring counts against the locked-memory limit.

## With Kommander

`SolariumWAL` takes the environment through its options. See [Solarium.Kommander](../integrations/kommander.md#io_uring).
