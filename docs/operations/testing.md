---
sidebar_position: 6
---

# Testing

The tests check that Solarium gives the right answers, and that the right data is there after a crash. This page explains how to run the Solarium test suite, and what the crash tests check.

## Run the tests

```shell
dotnet test
```

The tests of the storage layer, the SSTables, and the database take the storage environment as a parameter. On Linux with io_uring, they run once for each environment. On other machines, the suite uses the default storage environment only, and it passes there too.

## Test io_uring from macOS or Windows

Run the suite in a Linux container with Docker.

```shell
docker build -t solarium-test .
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 solarium-test
```

Docker needs both flags. The default seccomp profile blocks io_uring, and each ring counts against the locked-memory limit.

## Continuous integration

- `.github/workflows/ci.yml` tests on Linux. It fails when a test ran on the default storage environment but not on io_uring.
- `.github/workflows/windows.yml` tests on Windows, on the default storage environment, when you start it by hand. Windows enforces file share modes and does not have a directory fsync.

## Power-loss tests

`CrashTests` cuts the power at random operations of a random workload. The workload writes batches across column families, synced and not, with flushes and WAL rotation. It also has compactions, and the floor pass of Kommander with `DeleteFilesInRange`.

`PowerLossEnvironment` is a storage environment that records the contents of each file and the directory at their last flush. After a simulated power loss, it writes out one of the three states that a drive can leave.

- Only the flushed data.
- The flushed data and part of the rest, written in order.
- The flushed data and part of the rest, sector by sector in any order.

Each run crashes and reopens three times. This means that recovery itself is cut too. After each reopen, the database must hold exactly the first batches up to one point. That point must be at or after the last synced write that returned. No part of a later batch can be there.

| Variable | Effect |
| --- | --- |
| `SOLARIUM_CRASH_ITERATIONS` | The number of iterations. The default is 30 on each environment. |
| `SOLARIUM_CRASH_SEED` | The first seed. |

A failure names its seed and leaves the directories of the run on disk. Some seeds change the options to cut the power in more cases.

- Seeds 4 to 7 of each eight use four compaction threads, and compactions overlap in time.
- Seeds 8 to 15 of each sixteen pace their SSTables with a `RateLimiter`, and start their writeback at each 16 KB with `BytesPerSync`.
- Seeds 16 to 31 of each thirty-two cap their memtables across column families at 24 KB with `DbWriteBufferSize`.
- Seeds 32 to 63 of each sixty-four keep their index and filter blocks in a 4 KB block cache, which reads them again on most lookups. An odd seed also pins level 0.

## Kill tests

`KillTests` kills a real process with SIGKILL and checks what is left.

1. `tests/Solarium.CrashWorker` writes the same kind of workload to a directory.
2. Before it writes a batch, it prints the batch on standard output. After the write returns, it prints the sequence number.
3. The test kills it at a random moment, sometimes during the open of the database.
4. The test reopens the directory and checks it against that output.

A killed process does not lose data that is in the operating system. This means that every acknowledged batch must be there, synced or not. The batch in flight must be there whole or not at all. Each run kills three workers in a row in one directory.

The seeds change the options as in the power-loss tests. Seeds 4 to 7 of each eight use four compaction threads, and seeds 8 to 15 of each sixteen pace their SSTables. Seeds 16 to 31 of each thirty-two cap their memtables, and seeds 32 to 63 of each sixty-four use a small block cache. The default is 4 iterations on each environment. `SOLARIUM_KILL_ITERATIONS` and `SOLARIUM_KILL_SEED` change that.

## Concurrent compaction tests

`ConcurrentCompactionTests` starts several compactions at once and checks that they do not get in the way of one another.

- A held merge of one column family does not delay the merge of another.
- The picker passes over the files and the key ranges that other compactions use.
- A merge of level 0 can overlap in time with a merge of the level below, outside its range.
- A manual compaction waits for the active ones, and new ones wait for it.
- A compaction that fails beside another stops all writes, and the other installs nothing.
- `Dispose` stops all the active merges, and leaves none of their files.
- Many writers on several column families agree with a model during four compactions.

`ModelTests` also checks every read path against a `SortedDictionary` across the levels with four compaction threads.

## Pacing tests

`PacingTests` checks the rate limiter and `BytesPerSync`, alone and with flushes and compactions.

- A limiter hands out its rate one refill period at a time.
- Flushes go before compactions, and compactions progress even when the flushes do not stop.
- An auto-tuned limiter falls when idle and climbs under steady demand, within its range.
- A limiter does not accept a rate or a period that it cannot apply.
- A flush writes its SSTable 1 MiB at a time, and starts the writeback of each write.
- A limiter paces flushes and compactions, and the writeback comes with it.
- One limiter paces two databases.
- A failed writeback fails the flush, as a failed write does.

The tests that write SSTables run on each storage environment that the machine has: the default one, and io_uring on Linux.

## Checkpoint tests

`CheckpointTests` pauses a checkpoint at its first write with `HookedEnvironment`. In the meantime, it writes to the source, and flushes and compacts it. The copy must read as the source did when the checkpoint began. The tests also check the order of the files in the copy, and what happens when another operation gets in the way.

- **Write order.** The tables and `MANIFEST`, each made durable, come before `FORMAT`. Because of this order, a copy that was cut short does not open.
- **A race for the directory.** Another checkpoint, an open, or a new database takes the directory while a checkpoint is paused. The paused checkpoint must fail and leave the files as they were.
- **`Dispose` during a checkpoint, at each step.** It must stop the checkpoint, or wait for one that writes `FORMAT`.

## Other tests

- `SolariumDbTests` deletes the `MANIFEST` of a checkpoint and of a flushed database. It does the same with a database that has WAL files only. `Open` must refuse each one and change no byte of its files.
- `MisplacedBlockTests` swaps data blocks of equal size and copies a block from another table. It also replaces a table with an older one of the same size, or with the same-numbered table of another store. Each read or open must fail as corruption. A fixture written by the release before format 6 must open and read, and a compaction of it must work.
- `MemTableTests` checks the tombstone runs of the memtable against a scan of all the range tombstones. It does this after each range delete, at all the snapshots, while readers race the writer.
- The Kommander tests pause a commit marker at a read gate. At the same time, a higher commit of the same partition, or a partition delete, races it. The persisted commit frontier must not move back.

## Kommander and Kahuna tests

- `tests/Solarium.Kommander.Tests` has the conformance suite of Kommander and the ported `RocksDbWAL` behavior tests. It also has `WalCrashTests`, `ClusterTests`, `MetricsTests`, and the storage-damage tests `LostSyncedWriteTests`, `StorageDamageTests`, and `StorageVerdictTests`. See [Solarium.Kommander](../integrations/kommander.md#tests).
- `tests/Solarium.Kahuna.Tests` has the ported behavior tests of the RocksDB backend of Kahuna, and the storage-damage tests `TestStorageCorruption` and `TestStorageCorruptionNode`. See [Solarium.Kahuna](../integrations/kahuna.md#tests).

`WalCrashTests` does 24 iterations on each environment. `SOLARIUM_WAL_CRASH_ITERATIONS` and `SOLARIUM_WAL_CRASH_SEED` change that.
