---
sidebar_position: 2
---

# Tuning

The defaults of Solarium are the defaults of RocksDB, and they suit a general workload. This page explains which options to change for a given workload, and what each change costs. [Flushes and Compaction](../guides/flushes-and-compaction.md) explains the memtables, level 0, and the base level that these options control. [Options](../reference/options.md) lists every option.

## Memory

Each column family uses at most `WriteBufferSize × MaxWriteBufferNumber` bytes of memtables. With the defaults, that is 64 MB × 2 = 128 MB for each column family.

The memtables are in native memory, outside the managed heap, as in RocksDB. So the .NET garbage collector does not copy or mark them, and they do not count against its heap limit (`DOTNET_GCHeapHardLimit`). A node sized for RocksDB needs no larger heap limit for Solarium. The cached data blocks of `CacheDataBlocks` are native memory too. The index and filter partitions in the block cache stay on the managed heap.

For many column families, lower `WriteBufferSize` on the column families with few writes. Do not set it below a few megabytes, because each flush makes one level 0 file.

To cap the memtables of all the column families, or of several databases, use a `WriteBufferManager` (`DbOptions.WriteBufferManager`), or `DbOptions.DbWriteBufferSize` for one database. Past the cap, the database that writes next flushes its oldest memtable. It never stalls writes.

The open SSTables keep their index, Bloom filters, and range tombstones in memory: about 2% of the table bytes, and 4% with LZ4. `rocksdb.estimate-table-readers-mem` reports that size. It grows with the data on disk. To bound it, put the index and filter blocks in a block cache (`ColumnFamilyOptions.BlockCache` with `CacheIndexAndFilterBlocks`). Size the cache to hold them all. A smaller cache reads partitions again on its misses, and lookups slow down.

By default, the page cache of the operating system caches the data blocks. `CacheDataBlocks` keeps them in the block cache too. It made reads faster on a store that fits in the cache, and slower on a store ten times the cache. See [Cache data blocks](../guides/memory.md#cache-data-blocks).

## Write throughput

| Change | Effect | Cost |
| --- | --- | --- |
| Larger `WriteBufferSize` | Fewer flushes and fewer level 0 files. Entries that a range delete covers while in memory never reach an SSTable. | More memory. A longer replay at open. |
| Larger `MaxWriteBufferNumber` | Writes wait less often for a flush. | More memory. |
| Higher `Level0FileNumCompactionTrigger` | Fewer, larger compactions of level 0. | Reads search more level 0 files. |
| Higher slowdown and stop triggers | Fewer write stalls in a burst. | More level 0 files, and slower reads during the burst. |
| `Compression = Lz4` | Fewer bytes to write. In the Kahuna benchmark, loads were 1.3 to 1.7 times as fast. | CPU to compress, and to decompress on each read of a block. |
| Many writer threads | Group commit shares the WAL appends and flushes. | None. More writers usually means more throughput. |
| Higher `MaxBackgroundCompactions` | Level 0 stays lower, and writes stall less. | More bytes written. On a large store, slower synced writes, unless a `RateLimiter` paces the compactions. |
| A `RateLimiter` | Synced writes keep their share of the drive while flushes and compactions run. | The merges take longer after a burst. Too low a rate lets level 0 grow until writes stall. |
| `BytesPerSync` | Each SSTable reaches the drive while it is written, not all at its last sync. | Little. In the benchmark, the rate of synced writes changed by -5% to +18%, within the spread of the compactions. |

[Pace background writes](../guides/flushes-and-compaction.md#pace-background-writes) explains how to choose a rate for your drive.

The Kommander WAL uses this tuning for its shard column families: 128 MiB memtables, 3 memtables, and level 0 triggers of 8, 28, and 44.

## Read latency

- Keep the number of level 0 files low. Each level 0 file is one more source for each read.
- Keep the data in the page cache when you can. By default, data blocks have no cache in the process, so a read of a block that is not in the page cache goes to the drive.
- When the data that your reads use fits in a block cache, try `CacheDataBlocks`. Measure it: on a store ten times the cache, it made reads slower.
- With a block cache, size it to hold every index and filter partition, and pin level 0 with `PinL0FilterAndIndexBlocksInCache`.
- Read many keys with `MultiGet`, not one `Get` for each key. It reads their data blocks in one batch.
- Prefer `Next` to `Prev`. A `Prev` step searches every source.
- Dispose iterators quickly, so that compaction can delete old files.

## WAL size

`DbOptions.MaxTotalWalSize` limits the live WAL files. When they are larger, the column families that keep the oldest WAL file alive are flushed. The default, 0, means 4 times the sum of `WriteBufferSize × MaxWriteBufferNumber` over all column families.

Lower it when a restart must be fast. The open replays every live WAL file.

## Write stalls

`DbOptions.DelayedWriteRate` (16 MiB/s by default) is the rate that writes slow down to at the slowdown trigger. It is fixed: RocksDB changes it with the compaction backlog, and Solarium does not. See [Write Stalls](write-stalls.md).

## Group size

`DbOptions.MaxWriteBatchGroupSizeBytes` (1 MiB by default) caps the WAL records that one write group takes. A higher cap lets more writers share one append, but the writers of a large group wait longer for it. Keep the default unless a measurement shows a gain.

## Garbage collection

The memtables are native memory, but the write path still allocates managed memory: 1.6 to 9.2 KB for each unsynced Kommander entry of 1 KiB or more. In the Kommander WAL benchmark, with four unsynced writers:

- at 100 MB/s or less, collections paused the process for less than 1% of the time;
- the p99.9 latency was about three times that of RocksDB, and below 0.25 ms;
- the longest write took 13 to 26 ms, against 11 to 13 ms for RocksDB.

Run a server with the server GC: set `<ServerGarbageCollection>true</ServerGarbageCollection>` in the project file. Under the workstation GC, collections took 20% to 29% of an unsynced `Put`, against 7% to 9% under the server GC. See [Benchmarks](benchmarks.md#tail-latency-at-a-fixed-rate).
