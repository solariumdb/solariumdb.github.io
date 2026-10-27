---
sidebar_position: 6
---

# Testing

The tests of a storage engine must prove two things: that it gives the right answers, and that it keeps the right data after a crash. This page explains how to run the Solarium test suite, and what the crash tests check.

## Run the tests

```shell
dotnet test
```

The storage, SSTable, and database tests take the storage environment as a parameter. On Linux with io_uring, they run once for each environment. Without io_uring, the suite runs the default storage environment only and still passes.

## Test io_uring from macOS or Windows

Use Docker:

```shell
docker build -t solarium-test .
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 solarium-test
```

Docker needs both flags. The default seccomp profile blocks io_uring, and each ring counts against the locked-memory limit.

## Continuous integration

- `.github/workflows/ci.yml` runs on Linux. It fails when a test ran on the default storage environment but not on io_uring.
- `.github/workflows/windows.yml` runs the suite on Windows, on the default storage environment, when you start it by hand. Windows enforces file share modes and has no directory fsync.

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

A failure names its seed and keeps the directories of the run. Some seeds change the options, so the power loss also cuts these cases:

- Seeds 4 to 7 of each eight run four compaction threads, so compactions run side by side.
- Seeds 8 to 15 of each sixteen pace their SSTables with a `RateLimiter`, and start their writeback every 16 KB with `BytesPerSync`.
- Seeds 16 to 31 of each thirty-two cap their memtables across column families at 24 KB with `DbWriteBufferSize`.
- Seeds 32 to 63 of each sixty-four keep their index and filter blocks in a 4 KB block cache, which reads them again on most lookups. An odd seed also pins level 0.

## Kill tests

`KillTests` kills a real process with SIGKILL:

1. `tests/Solarium.CrashWorker` writes the same kind of workload to a directory.
2. It reports each batch on standard output before it writes it, and the sequence number after the write returns.
3. The test kills it at a random moment, sometimes while it still opens the database.
4. The test reopens the directory and checks it against the reports.

A killed process loses nothing that the operating system holds. So every acknowledged batch must be there, synced or not, and the batch in flight must be there whole or not at all. Each run kills three workers in a row in one directory. As in the power-loss tests, seeds 4 to 7 of each eight run four compaction threads, seeds 8 to 15 of each sixteen pace their SSTables, seeds 16 to 31 of each thirty-two cap their memtables, and seeds 32 to 63 of each sixty-four use a small block cache. The suite runs 4 runs on each environment. `SOLARIUM_KILL_ITERATIONS` and `SOLARIUM_KILL_SEED` change that.

## Concurrent compaction tests

`ConcurrentCompactionTests` runs several compactions at once and checks that they keep out of each other's way:

- A held merge of one column family does not hold back the merge of another.
- The picker passes over the files and the key ranges that running compactions hold.
- A merge of level 0 runs beside a merge of the level below, outside its range.
- A manual compaction waits for the running ones, and holds back new ones.
- A compaction that fails beside another stops all writes, and the other installs nothing.
- `Dispose` stops every merge that runs, and leaves no file of theirs.
- Many writers on several column families agree with a model while four compactions run.

`ModelTests` also checks every read path against a `SortedDictionary` across the levels with four compaction threads.

## Pacing tests

`PacingTests` checks the rate limiter and `BytesPerSync`:

- A limiter hands out its rate one refill period at a time.
- Flushes go before compactions, and compactions still progress while flushes never stop.
- An auto-tuned limiter falls when idle and climbs under steady demand, within its range.
- A limiter refuses a rate or a period that it cannot keep.
- A flush writes its SSTable 1 MiB at a time, and starts the writeback of each write.
- A limiter paces flushes and compactions, and the writeback comes with it.
- One limiter paces two databases.
- A failed writeback fails the flush, as a failed write does.

The tests that write SSTables run on each storage environment that the machine has: the default one, and io_uring on Linux.

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
