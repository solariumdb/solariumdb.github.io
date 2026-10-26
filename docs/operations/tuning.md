---
sidebar_position: 2
---

# Tuning

The defaults of Solarium are the defaults of RocksDB, and they suit a general workload. This page explains which options to change for a given workload, and what each change costs. [Flushes and Compaction](../guides/flushes-and-compaction.md) explains the memtables, level 0, and the base level that these options control. [Options](../reference/options.md) lists every option.

## Memory

Each column family uses at most `WriteBufferSize × MaxWriteBufferNumber` bytes of memtables. With the defaults, that is 64 MB × 2 = 128 MB for each column family.

The memtables are on the managed heap. So:

- the .NET garbage collector sees them, and their size counts toward its budget;
- a large memtable makes more work for gen 2 collections;
- there is no shared memtable budget across column families or databases yet.

For many column families, lower `WriteBufferSize` on the column families with few writes. Do not set it below a few megabytes, because each flush makes one level 0 file.

Solarium has no block cache. The page cache of the operating system caches the SSTables. The open SSTables keep their index, Bloom filter, and range tombstones in memory. `rocksdb.estimate-table-readers-mem` reports that size.

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
| `BytesPerSync` | Each SSTable reaches the drive while it is written, not all at its last sync. | Little. In the benchmark, it made synced writes 1% to 5% faster. |

[Pace background writes](../guides/flushes-and-compaction.md#pace-background-writes) explains how to choose a rate for your drive.

The Kommander WAL uses this tuning for its shard column families: 128 MiB memtables, 3 memtables, and level 0 triggers of 8, 28, and 44.

## Read latency

- Keep the number of level 0 files low. Each level 0 file is one more source for each read.
- Keep the data in the page cache when you can. With no block cache, a read of a block that is not in the page cache goes to the drive.
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

The memtables of Solarium are on the managed heap, so the garbage collector works in proportion to what you write. In the Kommander WAL benchmark:

- at the rates of a busy Raft node (up to about 100 MB/s for each node), the tail latency matched RocksDB;
- past that rate, gen 2 collections paused the process for up to about 90 ms;
- the server GC was 11% to 21% faster than the workstation GC on unsynced writes.

Run a server with `<ServerGarbageCollector>true</ServerGarbageCollector>`. For a very high ingest, a larger gen 0 budget (for example `DOTNET_GCgen0size=0x10000000`) shortened the p99.9 latency, but not the total pause.
