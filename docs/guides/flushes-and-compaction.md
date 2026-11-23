---
sidebar_position: 5
---

# Flushes and Compaction

Solarium flushes and compacts on background threads. You do not need to call anything for a healthy database. This guide explains what the background work does and what you can control. It also explains when to start the work yourself.

## Flushes

A **flush** writes a memtable to a new level 0 SSTable.

1. When the active memtable reaches `WriteBufferSize`, it becomes immutable at the next write group. A new active memtable takes the writes.
2. A background thread writes the oldest immutable memtable to an SSTable.
3. The manifest records the new SSTable. The WAL files that no memtable needs any more are deleted.

A column family has at most `MaxWriteBufferNumber` memtables: the active one and the immutable ones. At this count, writes wait for a flush.

You can start a flush yourself with `Flush`.

```csharp
db.Flush(log);               // waits until the data is durable in an SSTable
db.Flush(log, wait: false);  // returns at once
```

`Flush` makes the active memtable immutable at once. With `wait: true`, the default, it returns when that data is in an SSTable. The current WAL file changes at the next write group.

## Compaction

A **compaction** merges SSTables into a lower level. A column family has seven levels.

- **Level 0** contains the flushed memtables. Its files can overlap, and the newest comes first.
- **Levels 1 to 6** hold sorted files. In each level, the files are in key order and share no key.

For each key, the versions in a level are all newer than the versions in the levels below it.

```mermaid
flowchart TB
    M[Memtable] -- flush --> L0[Level 0: overlapping files]
    L0 -- compaction --> B[Base level]
    B -- compaction --> L5[...]
    L5 -- compaction --> L6[Level 6: the bottom level]
```

The levels are sized dynamically, as with `level_compaction_dynamic_level_bytes` in RocksDB.

- Level 6, the bottom level, does not have a target size.
- Each level above it has a target of one tenth (`MaxBytesForLevelMultiplier`) of the level below.
- Level 0 compacts into the **base level**: the highest level whose target is at most `MaxBytesForLevelBase` (256 MB).

This means that all the sorted data of a column family smaller than 256 MB is in level 6, and level 0 compacts directly into it.

Up to `MaxBackgroundCompactions` compactions run at once, across all column families, with one thread for each. The default is 1. Each compaction thread takes the level with the highest score of at least 1.

- The score of level 0 is its file count divided by `Level0FileNumCompactionTrigger` (4).
- The score of each sorted level above level 6 is its size divided by its target.

### Trivial moves

A file that does not overlap a file in the level below moves down as it is, with one manifest save and no rewrite. This is how an append-only key space, such as a Raft log, reaches level 6 with no compaction writes.

## Run several compactions at once

When level 0 grows faster than one compaction can empty it, writes stall. `MaxBackgroundCompactions` lets more compactions run at the same time.

```csharp
using SolariumDb db = SolariumDb.Open("./data", new DbOptions { MaxBackgroundCompactions = 4 });
```

Compactions that run at the same time follow three rules.

- Two compactions never read the same file.
- They do not compact level 0 of one column family at the same time.
- They do not write overlapping files into one level.

For each key, the versions in a level remain newer than those in the levels below, as with one thread.

In the compaction benchmark with random keys, 6 threads wrote 1.8 times the rows per second of RocksDB, and writes stalled for 0.5 s. Compaction wrote 4.63 times the bytes of the data. However, the threads write at the same time, and on a slow drive they take it from synced writes. On a drive whose synced writes took 4 to 8 ms, 8 threads with no limiter made synced batches slower than one thread did. A [rate limiter](#pace-background-writes) reserves a share of the drive for synced writes. On a drive whose synced writes took about 1 ms, 8 threads with no limiter were faster than one. See [Benchmarks](../operations/benchmarks.md#concurrent-compactions).

The default of `SolariumWAL`, the Kommander WAL, is 6 compactions on 16 CPUs. The default of `Solarium.Kahuna` is one compaction, which protects the speed of its synced writes.

## Pace background writes

A synced write waits until the drive has its WAL records. Flushes and compactions write large SSTables to the same drive. On a drive with little bandwidth for synced writes, a burst of table writes makes each synced write wait longer. A **rate limiter** caps the bytes per second that flushes and compactions write. This leaves a share of the drive for synced writes.

```csharp
RateLimiter limiter = new(50L * 1024 * 1024);  // 50 MiB/s for all flushes and compactions

using SolariumDb db = SolariumDb.Open("./data", new DbOptions
{
    MaxBackgroundCompactions = 8,
    RateLimiter = limiter,
});
```

The limiter gives bytes to flushes and compactions from a budget that refills.

- A flush or a compaction writes its SSTable through a 1 MiB buffer. Before each write of the buffer, it asks the limiter for those bytes. When the budget is spent, it waits.
- The budget refills every 100 ms with the rate times the period. Flushes go before compactions. One refill in ten serves the compactions first, and for this reason they always progress.
- With a limiter, `BytesPerSync` is 1 MiB by default. After each 1 MiB, the writer starts the writeback of what it wrote (`sync_file_range` on Linux) and does not wait for it. This means that the table reaches the drive in steps while it is written. `BytesPerSync` does not make data durable. You can also set it when there is no limiter.
- The WAL, the manifest, and checkpoints are not paced. The flushes of the WAL replay at open are not paced either.
- One limiter can pace several databases on one drive. Pass the same instance to each `DbOptions`. `SetBytesPerSecond` changes the rate while the databases run.

The limiter paces flushes too. You should choose a rate between these two limits.

- **Above what the store ingests.** Flushes must keep up with the writes. Below that rate, each memtable switch waits for a flush, and writes slow down.
- **Below what the drive can write beside the WAL syncs.** Above that rate, the table writes take the drive from synced writes again.

On a drive whose synced writes took 4 to 8 ms, the synced batches wrote 11,000 to 13,000 rows per second. There, a limiter of 50 MiB/s brought 8 compaction threads back to the rate of one thread, and made the synced batches of 64 rows of Kahuna 2.5 to 3 times as fast. On the same drive at about 1 ms for each synced write, the batches wrote 50 to 65 MB/s. A limiter of 25 or 50 MiB/s was then below the ingest. Every memtable switch waited for a flush, and the batches slowed to 0.2 to 0.4 times their rate with no limiter. See [Paced background writes](../operations/benchmarks.md#paced-background-writes).

A limiter has a cost after a burst, and a wrong rate slows writes.

- **The work moves to after the burst.** The merges that a load leaves behind run after it, at the rate of the limiter.
- **The rate depends on the drive and on the ingest.** Measure both before you choose. Too low a rate makes flushes fall behind, and lets level 0 grow until writes stall.
- **Auto-tuning does not protect synced writes.** `new RateLimiter(rate, autoTuned: true)` starts at half its rate and moves between a twentieth of it and all of it. When no write waits, it drops to the bottom, and it climbs back by 5% every 10 seconds. In the benchmark, it fell to about 3 MiB/s, level 0 passed the slowdown trigger, and synced writes waited for the stall. That run came before a fix to how the limiter counts the time that writes waited, and was not measured again. Use auto-tuning only with a high rate, to smooth bursts.

`Solarium.Kahuna` sets a limiter if you give it a rate with `--storage-compaction-rate-mbps`. There is no limiter by default. See [Solarium.Kahuna](../integrations/kahuna.md#pace-the-compactions).

## Manual compaction

```csharp
db.CompactRange(null, null, family);  // the whole column family
```

`CompactRange` compacts a key range down to the bottom level. It does not flush the memtable first. It is the only compaction while it works, and no automatic compaction starts. See [Range Deletes](range-deletes.md#compactrange).

## Turn off automatic compaction

```csharp
new ColumnFamilyOptions { DisableAutoCompactions = true }
```

With `DisableAutoCompactions`, automatic compactions do not start for that column family. You can call `CompactRange`. The level 0 file count of that column family does not slow or stop writes, because no compaction would end the stall. However, writes stop when the column family has `MaxWriteBufferNumber` memtables.

Use this for a bulk load that you compact once at the end.

## Compression

```csharp
new ColumnFamilyOptions { Compression = CompressionType.Lz4 }
```

`Compression` sets how flushes and compactions store the data blocks of new SSTables. The default is `None`. The only codec is `Lz4`. A block that LZ4 makes smaller by less than one eighth is stored raw.

The compression of an SSTable does not change after it is written. This means that you can change the option between opens. Unless `CacheDataBlocks` is on, data blocks are not cached in the process, and each read of a compressed block decompresses it. In the Kahuna benchmarks, LZ4 made the store 40% smaller and loads faster, with no measured cost on reads.

## What you can watch

| Property | Meaning |
| --- | --- |
| `rocksdb.num-files-at-level0` to `rocksdb.num-files-at-level6` | The SSTables in each level. |
| `rocksdb.base-level` | The level that level 0 compacts into. |
| `rocksdb.compaction-pending` | 1 when a level needs a compaction. |
| `rocksdb.mem-table-flush-pending` | 1 when a memtable waits for a flush that has not started. |
| `rocksdb.num-running-flushes` | 0 or 1. There is one flush thread. |
| `rocksdb.num-running-compactions` | From 0 to `MaxBackgroundCompactions`. |

A `RateLimiter` also counts what it paced: `TotalBytesThrough`, `TotalRequests`, and `TotalWait`, the time that writes waited for their bytes.

[Diagnostics](../operations/diagnostics.md) explains how to read them.

## Failures

A flush or compaction failure stops all later writes until you open the database again. A failed writeback of `BytesPerSync` fails the flush or the compaction, as a failed write does. Reads continue. A crash during a compaction leaves orphan files, and the next open deletes them.
