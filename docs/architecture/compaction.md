---
sidebar_position: 6
---

# Compaction

A **compaction** merges SSTables into a lower level. It removes old versions and deleted keys, and keeps the number of files that a read searches low. Solarium compacts into the seven levels of RocksDB, with its dynamic level sizing. Up to `MaxBackgroundCompactions` compactions run at once, across all column families, each on its own thread (`solarium-compaction-0`, `solarium-compaction-1`, and so on). The default is 1.

## The levels

- **Level 0** holds the flushed memtables. Its files can overlap. The newest file comes first.
- **Levels 1 to 6** hold sorted files. In each level, the files are in key order and share no key.

For each key, every version in a level is newer than every version in the levels below it.

## Level sizes

The levels are sized as with the `level_compaction_dynamic_level_bytes` of RocksDB, its default:

1. Level 6, the bottom level, holds what it holds.
2. Each level above it has a target of one `MaxBytesForLevelMultiplier`th (one tenth by default) of the level below.
3. Level 0 compacts into the **base level**: the highest level whose target is still at most `MaxBytesForLevelBase` (256 MB). The base level is never below the first level with files, so the levels above the base level are empty.

`LevelTargets` computes this as the `VersionStorageInfo::CalculateBaseBytes` of RocksDB.

Examples:

| Bytes in level 6 | Targets | Base level |
| --- | --- | --- |
| Less than 256 MB | none above level 6 | Level 6. Level 0 compacts directly into it. |
| 4.3 GB | 430 MB for level 5, 256 MB for level 4 | Level 4 |

## Scores

Each level of each column family has a **score**, as in RocksDB:

- Level 0: its file count divided by `Level0FileNumCompactionTrigger`.
- Each level from the base level to level 5: its bytes divided by its target.

The level with the highest score of at least 1, across all column families, goes first. The scores leave out the files that running compactions read.

## The kinds of compaction

### Level 0 into the base level

1. From the oldest level 0 file, the files that overlap neither each other nor a file of the base level **move** there as they are. One manifest save changes their level, and they keep their numbers.
2. The first file that overlaps ends this walk. So every file that stays in level 0 is newer than every file that moves.
3. If no file can move, the oldest file is **merged**. The merge takes every level 0 file that overlaps it (and the files that overlap those), and the files of the base level in their range. It writes new files of the base level.

### A sorted level into the level below

The compaction takes one file: the file whose overlap in the level below is smallest against its own size. This is the default of RocksDB, `kMinOverlappingRatio`. It merges that file with every file of the level below that it overlaps.

A file that overlaps nothing in the level below moves down as it is. This is how an append-only key space, such as a Raft log, reaches level 6 with no rewrite.

```mermaid
flowchart LR
    subgraph L5[Level 5]
        A["[a, c]"]
        B["[m, p]"]
    end
    subgraph L6[Level 6]
        C["[b, e]"]
        D["[x, z]"]
    end
    A -- overlaps: merge --> C
    B -- no overlap: move --> L6
```

## The merge

A merge reads every version of a key in the levels that it reads. So it keeps only the newest version of each key, and only when no range tombstone of the inputs covers it. Below the output level, older versions of the key can still exist. So the merge keeps the markers that hide them:

- A **point delete** stays while a file of a lower level holds its key, as the `KeyNotExistsBeyondOutputLevel` of RocksDB asks.
- A **range tombstone** stays while a file below overlaps it.
- A merge into level 6 drops them all.

A range tombstone that stays is cut at the boundaries between the output files, as RocksDB truncates them. So the key range of each file covers its tombstones. The cut piece in a file ends at the first key of the next file, which is then the largest bound of the file, excluded. A table records when its largest bound is the end of a tombstone that none of its entries has (`TableProperties.LargestIsExclusive`). So two files of a level can meet at that key without overlapping.

A range where everything is deleted, and where nothing below needs a tombstone, leaves no file. Output files end at `TargetFileSizeBase`, between two keys.

## Install

1. One manifest save replaces the inputs with the outputs.
2. A new version replaces the version of the column family.
3. A reader of an older version continues to read the files of that version.
4. A file that left the manifest is deleted when the last version that lists it closes.

A crash before the manifest save leaves the outputs as orphans. A crash after it leaves the inputs as orphans. The next open deletes them.

## DeleteFilesInRange

`DeleteFilesInRange` drops, in one manifest save, the files of levels 1 to 6 whose keys all lie in a range. It leaves level 0, the memtables, and the files of a compaction that runs.

As in RocksDB, it ignores sequence numbers:

- A key of a dropped file is gone for later reads, even when no delete was written for it.
- Reads and iterators that started before the call still see it.
- An older version of a key, in a lower file that reaches past the range, can come back.

Kommander removes the dead prefix of a Raft log this way, with no rewrite. The files of one partition do not overlap, so they move down whole. Each one is dropped when its last entry is below the compaction floor.

## CompactRange

`CompactRange` compacts the range one level after the other, as the manual compaction of RocksDB does:

1. The level 0 files in the range go into the base level.
2. Each level from the base level to level 5 goes into the level below, in the range.

It runs on the calling thread, and returns when the last compaction is installed. So a delete in the range reaches the bottom and drops what it hides. As in RocksDB with no compaction filter, level 6 files alone are not rewritten.

A manual compaction runs alone, as with `exclusive_manual_compaction`, the default of RocksDB. While it waits, no automatic compaction starts. Each of its steps waits until no other compaction runs.

## Several compactions at once

With `MaxBackgroundCompactions` above 1, compactions run side by side. They keep out of each other's way, as the compaction picker of RocksDB does:

- A file that a running compaction reads is not picked again, as with `being_compacted` in RocksDB.
- A column family has one level 0 compaction at a time, because level 0 files overlap.
- A merge of level 0 waits while a file of the base level in its range is in a running compaction.
- A compaction into a level waits while a running compaction into that level writes an overlapping range, as with `RangeOverlapWithCompaction` in RocksDB. So their outputs never overlap.

So, for each key, the versions in a level stay newer than those below. A merge into a level holds every file of that level in its range, and no other compaction can move a version of those keys past it.

Each compaction installs on its own, in one manifest save under the state lock, into the version that the installs of the others left.

The trade-off, measured in the benchmarks with random keys:

| | 1 thread | 6 threads | RocksDB |
| --- | ---: | ---: | ---: |
| Write amplification | 4.28 | 5.06 | 4.62 |
| Most level 0 files | 32 | 22 | 17 |
| Time that writes stalled | 3.5 s | 0 s | 131.8 s |

With one thread, the score of level 0 always wins, so each merge of level 0 takes many files at once. With more threads, the sorted levels compact as soon as they pass their targets, and each such merge rewrites about ten times its size from level 6, as in RocksDB.

The threads also write at the same time, just after the flushes, when synced writes need the drive. The order of the compactions does not change that: the scores of RocksDB for dynamic level sizing, tried in Solarium, gave the same synced rates. [Paced writes](#paced-writes) is the remedy.

## Paced writes

A flush or a compaction writes its SSTable through a 1 MiB buffer, as the `WritableFileWriter` of RocksDB with its default `writable_file_max_buffer_size`. So it makes one write for each megabyte, not two for each block.

With a `RateLimiter`, the writer asks the limiter for the bytes of each write first, as with the `GenericRateLimiter` of RocksDB:

1. Each refill period (100 ms by default) hands out the rate times the period.
2. A flush asks at high priority, and a compaction at low priority. So the flushes are served first. On every tenth refill, the compactions are served first.
3. A write that finds the budget spent waits for the next refill.
4. A write larger than the budget of one period asks for its bytes in pieces.

An auto-tuned limiter starts at half its rate. Every 100 periods, it moves up by 5% when writes waited in more than 90% of the periods, and down by 5% when they waited in fewer than half. When no write waited, it drops to a twentieth of its rate.

After every `BytesPerSync` bytes of a table (1 MiB once a `RateLimiter` is set), the writer calls `IStorageFile.SyncRange`. The table then reaches the drive while it is written, not all at its last sync, where it would hold up the WAL syncs of the same moment. A failed range sync fails the write of the table, as the `RangeSync` of RocksDB does.

The WAL, the manifest, checkpoints, and the flushes of the WAL replay inside `Open` are not paced. The replay has no write to share the drive with.

## Dispose and failures

`Dispose` stops every merge that runs, and deletes what each one wrote. A compaction failure, like a flush failure, stops all later writes until the database opens again. After a compaction fails, no other compaction installs, and a merge that ends later deletes its outputs.
