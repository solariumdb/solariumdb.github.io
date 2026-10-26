---
sidebar_position: 6
---

# Testing

The tests of a storage engine must prove two things: that it gives the right answers, and that it keeps the right data after a crash. This page explains how to run the Solarium test suite, and what the crash tests check.

## Run the tests

```shell
dotnet test
```

The storage, SSTable, and database tests take the storage environment as a parameter. On Linux with io_uring, they run once for each environment. Without io_uring, the suite runs the default environment only and still passes.

## Test io_uring from macOS or Windows

Use Docker:

```shell
docker build -t solarium-test .
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 solarium-test
```

Docker needs both flags. The default seccomp profile blocks io_uring, and each ring counts against the locked-memory limit.

## Continuous integration

- `.github/workflows/ci.yml` runs on Linux. It fails when a test ran on the default environment but not on io_uring.
- `.github/workflows/windows.yml` runs the suite on Windows, on the default environment, when you start it by hand. Windows enforces file share modes and has no directory fsync.

## Power-loss tests

`CrashTests` cuts the power at random operations of a random workload. The workload has batches across column families, synced and not, with flushes, WAL rotation, compactions, and the floor pass of Kommander with `DeleteFilesInRange`.

`PowerLossEnvironment` is a storage environment that keeps what each file and the directory held at their last flush. A crash writes out what a power loss can leave:

- only the flushed data;
- or the flushed data and part of the rest, written in order;
- or the flushed data and part of the rest, sector by sector in any order.

Each run crashes and reopens three times, so recovery itself is cut too. After each reopen, the database must hold exactly the first batches up to one point. That point must be at or after the last synced write that returned. Nothing of a later batch must be there.

| Variable | Effect |
| --- | --- |
| `SOLARIUM_CRASH_ITERATIONS` | More runs. The default is 30 on each environment. |
| `SOLARIUM_CRASH_SEED` | The first seed. |

A failure names its seed and keeps the directories of the run.

## Kill tests

`KillTests` kills a real process with SIGKILL:

1. `tests/Solarium.CrashWorker` writes the same kind of workload to a directory.
2. It reports each batch on standard output before it writes it, and the sequence number after the write returns.
3. The test kills it at a random moment, sometimes while it still opens the database.
4. The test reopens the directory and checks it against the reports.

A killed process loses nothing that the operating system holds. So every acknowledged batch must be there, synced or not, and the batch in flight must be there whole or not at all. Each run kills three workers in a row in one directory. The suite runs 4 runs on each environment. `SOLARIUM_KILL_ITERATIONS` and `SOLARIUM_KILL_SEED` change that.

## Checkpoint tests

`CheckpointTests` holds a checkpoint at its first write with `HookedEnvironment`, and writes, flushes, and compacts the source in the meantime. The copy must read as the source did when the checkpoint began. The tests also check:

- the order that makes a copy that was cut short refuse to open: the tables and `MANIFEST`, each made durable, before `FORMAT`;
- a race for the directory: another checkpoint, an open, or a new database takes the directory while a checkpoint is held. The held checkpoint must fail and leave every file as it was;
- `Dispose` during a checkpoint, at each step. It must stop the checkpoint, or wait for one that writes `FORMAT`.

## Other tests

- `SolariumDbTests` deletes the `MANIFEST` of a checkpoint, of a flushed database, and of a database with WAL files only. `Open` must refuse each one and change no byte of its files.
- `MemTableTests` checks the runs of range tombstones in the memtable against a scan of all of them, after every range delete and at every snapshot, while readers race the writer.
- In the Kommander tests, a read gate holds a commit marker while a higher commit of the same partition, or a partition delete, races it. The persisted commit frontier must not move back.

## Kommander and Kahuna tests

- `tests/Solarium.Kommander.Tests` holds the conformance suite of Kommander, the ported `RocksDbWAL` behavior tests, `WalCrashTests`, `ClusterTests`, and `MetricsTests`. See [Solarium.Kommander](../integrations/kommander.md#tests).
- `tests/Solarium.Kahuna.Tests` holds the ported behavior tests of the RocksDB backend of Kahuna. See [Solarium.Kahuna](../integrations/kahuna.md#tests).

`WalCrashTests` runs 24 runs on each environment. `SOLARIUM_WAL_CRASH_ITERATIONS` and `SOLARIUM_WAL_CRASH_SEED` change that.
