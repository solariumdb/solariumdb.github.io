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

`MaxWriteBatchGroupSizeBytes` or `MaxBackgroundCompactions` below 1, or a negative `BytesPerSync`, also throws.

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

## WriteOptions

| Option | Default | Description |
| --- | --- | --- |
| `Sync` | `false` | Flushes the WAL before the write returns, so the write survives a power loss. |

`WriteOptions.Default` and `WriteOptions.Synced` are shared instances.

## ReadOptions

| Option | Default | Description |
| --- | --- | --- |
| `IterateUpperBound` | `null` | An iterator stops before the first key at or after this key. Null: no bound. |

`ReadOptions.Default` is a shared instance.

## SolariumWalOptions

The options of `SolariumWAL` are on the [Solarium.Kommander](../integrations/kommander.md#options) page.
