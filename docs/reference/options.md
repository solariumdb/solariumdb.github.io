---
sidebar_position: 2
---

# Options

Options are records with `init` properties. You pass them each time you open the database. They are not stored in the directory, so you can change them between opens. An option out of range throws `ArgumentException` at `Open`.

[Tuning](../operations/tuning.md) explains when to change each option.

## DbOptions

The options of the whole database, for `SolariumDb.Open`.

| Option | Default | Description | RocksDB equivalent |
| --- | --- | --- | --- |
| `CreateIfMissing` | `true` | Creates the database directory when it does not exist. | `create_if_missing` |
| `CreateMissingColumnFamilies` | `false` | Creates the column families passed to `Open` that do not exist yet. When false, a missing one is an error. | `create_missing_column_families` |
| `Environment` | `DefaultStorageEnvironment.Instance` | Where the file I/O goes. | `env` |
| `DefaultColumnFamilyOptions` | `new()` | The options of every column family that `ColumnFamilyOptions` does not name. | The options of each column family descriptor |
| `ColumnFamilyOptions` | `null` | The options of named column families. Null: every column family uses `DefaultColumnFamilyOptions`. | The options of each column family descriptor |
| `MaxTotalWalSize` | `0` | When the live WAL files are larger than this, flush the column families that keep the oldest one alive. 0: 4 times the sum of `WriteBufferSize × MaxWriteBufferNumber` over all column families. | `max_total_wal_size` |
| `DelayedWriteRate` | 16 MiB/s | The rate, in bytes per second, that writes slow down to at the slowdown trigger. Must be positive. | `delayed_write_rate` |
| `MaxWriteBatchGroupSizeBytes` | 1 MiB | The most bytes of WAL records that one write group takes. Must be positive. | `max_write_batch_group_size_bytes` |
| `MaxBackgroundCompactions` | 1 | The most compactions that run at once, across every column family, each on its own thread. Flushes have one thread of their own. Must be positive. | `max_background_compactions` |
| `RateLimiter` | `null` | Paces the bytes that flushes and compactions write. Flushes go first. The WAL, the manifest, and checkpoints are not paced. One limiter can pace several databases. See [RateLimiter](#ratelimiter). | `rate_limiter`, writes only (`kWritesOnly`) |
| `WriteBufferManager` | `null` | Caps the memtables of every database that shares it. Past the cap, the next database to write flushes its column family with the oldest memtable. Overrides `DbWriteBufferSize`. See [WriteBufferManager](#writebuffermanager). | `write_buffer_manager` |
| `DbWriteBufferSize` | 0 | A memtable cap for this database alone, across its column families. Ignored when `WriteBufferManager` is set. 0: none. Must not be negative. | `db_write_buffer_size` |
| `BytesPerSync` | 0, or 1 MiB with a `RateLimiter` | After this many bytes of an SSTable, a flush or a compaction starts the writeback of what it wrote (`sync_file_range` on Linux, nothing elsewhere). It makes nothing durable. 0: never. Must not be negative. | `bytes_per_sync`, for SSTables |

## ColumnFamilyOptions

The options of one column family.

| Option | Default | Description | RocksDB equivalent |
| --- | --- | --- | --- |
| `WriteBufferSize` | 64 MB | The memtable size at which the memtable becomes immutable and is flushed. Must be positive. | `write_buffer_size` |
| `MaxWriteBufferNumber` | 2 | The most memtables, active and immutable, that the column family holds. At this count, writes wait for a flush. At least 2. | `max_write_buffer_number` |
| `Level0FileNumCompactionTrigger` | 4 | The level 0 files at which a compaction starts. At least 1. | `level0_file_num_compaction_trigger` |
| `Level0SlowdownWritesTrigger` | 20 | The level 0 files at which writes to every column family slow down. At least the compaction trigger. | `level0_slowdown_writes_trigger` |
| `Level0StopWritesTrigger` | 36 | The level 0 files at which writes to every column family stop. At least the slowdown trigger. | `level0_stop_writes_trigger` |
| `TargetFileSizeBase` | 64 MB | The size at which a compaction ends an output SSTable. A file ends only between two keys, so it can be a little larger. At least 1. | `target_file_size_base` |
| `MaxBytesForLevelBase` | 256 MB | The most bytes that the base level may hold. A column family smaller than this keeps all its sorted data in level 6. | `max_bytes_for_level_base`, with `level_compaction_dynamic_level_bytes` always on |
| `MaxBytesForLevelMultiplier` | 10 | How many times the target of a level is the target of the level above it. A finite number above 1. | `max_bytes_for_level_multiplier` |
| `DisableAutoCompactions` | `false` | No compaction starts on its own. `CompactRange` still compacts, and the level 0 file count slows and stops no writes. | `disable_auto_compactions` |
| `Compression` | `None` | How new SSTables store their data blocks: `None` or `Lz4`. Old tables keep their own compression. | `compression`. The default of RocksDB is Snappy. |
| `BlockCache` | `null` | The cache for the index and filter blocks of the SSTables, with `CacheIndexAndFilterBlocks`. Several column families and databases can share one. Data blocks are never cached. See [Cache](#cache). | `BlockBasedTableOptions::block_cache` |
| `CacheIndexAndFilterBlocks` | `false` | Keeps the index and filter partitions of each SSTable in `BlockCache`, not in the memory of the table. Needs a `BlockCache`. | `cache_index_and_filter_blocks` |
| `PinL0FilterAndIndexBlocksInCache` | `false` | Pins the index and filter partitions of level 0 tables in `BlockCache` while they are in level 0. Only with `CacheIndexAndFilterBlocks`. | `pin_l0_filter_and_index_blocks_in_cache` |

The slowdown and stop triggers do not apply when `DisableAutoCompactions` is set.

## Validation

RocksDB corrects some values with a warning in its log. Solarium has no log, so it throws `ArgumentException` instead:

| Value | Solarium | RocksDB |
| --- | --- | --- |
| `Level0FileNumCompactionTrigger` or `TargetFileSizeBase` below 1 | Throws | Raises a trigger of 0 to 1 |
| A slowdown trigger below the compaction trigger | Throws | Raises it to the compaction trigger |
| A stop trigger below the slowdown trigger | Throws | Raises it to the slowdown trigger |
| `DelayedWriteRate` below 1 | Throws | Takes 0 as 16 MiB/s |
| `MaxWriteBufferNumber` below 2 | Throws | Raises it to 2 |
| `CacheIndexAndFilterBlocks` without a `BlockCache` | Throws | Gives the table factory an 8 MB cache of its own |

`MaxWriteBatchGroupSizeBytes` or `MaxBackgroundCompactions` below 1, or a negative `BytesPerSync` or `DbWriteBufferSize`, also throws.

## RateLimiter

A class in the namespace `Solarium`, as the `GenericRateLimiter` of RocksDB. It paces writes only. See [Differences from RocksDB](rocksdb-differences.md#rate-limiter). You create it and pass it to `DbOptions.RateLimiter`. [Pace background writes](../guides/flushes-and-compaction.md#pace-background-writes) explains when to use it.

```csharp
RateLimiter limiter = new(bytesPerSecond: 50L * 1024 * 1024);
```

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `RateLimiter(long bytesPerSecond, TimeSpan? refillPeriod = null, bool autoTuned = false, int fairness = 10)` | A limiter of `bytesPerSecond`, refilled every `refillPeriod` (100 ms by default). Every `fairness`th refill serves the compactions first. A value below 1, or a period under 1 ms, throws `ArgumentOutOfRangeException`. | `NewGenericRateLimiter` |
| `long BytesPerSecond` | The rate now: the rate given, or where auto-tuning moved it. | |
| `void SetBytesPerSecond(long bytesPerSecond)` | Changes the rate from the next refill. For an auto-tuned limiter, it sets the top of its range. | `SetBytesPerSecond` |
| `TimeSpan RefillPeriod` | How often the budget refills. | |
| `bool AutoTuned` | True when the rate tunes itself. An auto-tuned limiter starts at half its rate and moves between a twentieth of it and all of it. | `auto_tuned` |
| `long SingleBurstBytes` | The budget of one refill period. A larger write asks for its bytes in pieces of this size. | `GetSingleBurstBytes` |
| `long TotalBytesThrough` | The bytes asked for so far. | `GetTotalBytesThrough` |
| `long TotalRequests` | The pieces asked for so far. | `GetTotalRequests` |
| `TimeSpan TotalWait` | The time that writes waited for their bytes so far, summed over the waiting writes. | |

## Cache

A class in the namespace `Solarium`, as the `NewLRUCache` of RocksDB with `strict_capacity_limit = false`. It holds the index and filter blocks of SSTables and, through a `WriteBufferManager` created with it, the memory of memtables. [Block Cache and Memtable Budget](../guides/memory.md) explains how to size it.

```csharp
Cache cache = new(capacity: 512L * 1024 * 1024);
```

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `Cache(long capacity, int shardBits = -1)` | A cache of `capacity` bytes in 2^`shardBits` shards. -1 picks the count of RocksDB: as many shards as keep each at 512 KiB or more, up to 64. A negative capacity, or `shardBits` below -1 or above 20, throws `ArgumentOutOfRangeException`. | `NewLRUCache(capacity, num_shard_bits)` |
| `long Capacity` | The capacity in bytes. | `GetCapacity` |
| `void SetCapacity(long capacity)` | Changes the capacity. A smaller one evicts at once. | `SetCapacity` |
| `long Usage` | The bytes of the cached entries, pinned ones included. | `GetUsage` |
| `long PinnedUsage` | The bytes that cannot be evicted: the partitions of level 0 tables with `PinL0FilterAndIndexBlocksInCache`, and the memtable charges of a `WriteBufferManager`. | `GetPinnedUsage` |
| `int ShardCount` | The number of shards. | |

The capacity is soft. When only pinned entries are left, the cache stays over its capacity instead of failing a read.

## WriteBufferManager

A class in the namespace `Solarium`, as the `WriteBufferManager` of RocksDB with no stall. You create it and pass it to `DbOptions.WriteBufferManager` of each database that shares the cap.

```csharp
WriteBufferManager memtables = new(bufferSize: 256L * 1024 * 1024, cache);
```

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `WriteBufferManager(long bufferSize, Cache? cache = null)` | A manager with a cap of `bufferSize` bytes. With a `cache`, it also charges the memtables to the cache, in pinned entries of 256 KiB. A cap below 1 throws `ArgumentOutOfRangeException`. | `WriteBufferManager(buffer_size, cache)` |
| `long BufferSize` | The cap in bytes. | `buffer_size` |
| `void SetBufferSize(long bufferSize)` | Changes the cap. The next write of each database checks the new one. | `SetBufferSize` |
| `long MemoryUsage` | The memtables of every database that shares the manager, active and immutable. A memtable leaves it when its flush installs its table. | `memory_usage` |
| `long MutableMemoryUsage` | The part of `MemoryUsage` in active memtables. | `mutable_memtable_memory_usage` |
| `Cache? Cache` | The cache that the manager charges, or null. | |
| `const long CacheChargeUnit` | 256 KiB, the size of one charge entry. | `kSizeDummyEntry` |

## WriteOptions

| Option | Default | Description |
| --- | --- | --- |
| `Sync` | `false` | Flushes the WAL before the write returns, so the write survives a power loss. |

`WriteOptions.Default` and `WriteOptions.Synced` are shared instances.

## ReadOptions

| Option | Default | Description |
| --- | --- | --- |
| `IterateUpperBound` | `null` | An iterator stops before the first key at or after this key. Null: no bound. |
| `FillCache` | `true` | When false, a partition of an index and filter that the `BlockCache` evicted is read for this read only, and not cached again. Without a cache, it changes nothing. |

`ReadOptions.Default` is a shared instance.

## SolariumWalOptions

The options of `SolariumWAL` are on the [Solarium.Kommander](../integrations/kommander.md#options) page.
