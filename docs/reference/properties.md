---
sidebar_position: 3
---

# Properties

`GetProperty` takes the property names of RocksDB, with the `rocksdb.` prefix, and returns a decimal integer as a string. It returns null for a name that it does not support. The values match those of RocksDB for the same writes, flushes, and compactions, except for the memory figures noted below.

```csharp
string? value = db.GetProperty("rocksdb.num-files-at-level0", family);
```

## Properties of a column family

These take a column family. When you pass none, they use the default column family.

| Property | Value |
| --- | --- |
| `rocksdb.num-entries-active-mem-table` | The entries of the active memtable. Every put, delete, and range delete counts. |
| `rocksdb.num-immutable-mem-table` | The memtables that wait for a flush or are in a flush. |
| `rocksdb.mem-table-flush-pending` | 1 when a memtable waits for a flush that has not started, else 0. |
| `rocksdb.cur-size-all-mem-tables` | The bytes of the active memtable and of the memtables not yet flushed. |
| `rocksdb.estimate-table-readers-mem` | The bytes that the open SSTables keep in memory: index, filter, and range tombstones. With `CacheIndexAndFilterBlocks`, the range tombstones only. |
| `rocksdb.live-sst-files-size` | The bytes of the SSTables of the current version. |
| `rocksdb.num-files-at-level0` to `rocksdb.num-files-at-level6` | The SSTables in each level. |
| `rocksdb.base-level` | The level that level 0 compacts into. |
| `rocksdb.block-cache-capacity` | The capacity of the `BlockCache` of the column family. |
| `rocksdb.block-cache-usage` | The bytes in that cache, for everything that shares it, pinned entries included. |
| `rocksdb.block-cache-pinned-usage` | The bytes of that cache that cannot be evicted. |
| `rocksdb.compaction-pending` | 1 when a level needs a compaction, else 0. That is, level 0 holds `Level0FileNumCompactionTrigger` files, or a sorted level above the bottom holds more than its target. The files that a compaction reads do not count. |

## Properties of the database

These are the same for every column family.

| Property | Value |
| --- | --- |
| `rocksdb.num-running-flushes` | 0 or 1. There is one flush thread. |
| `rocksdb.num-running-compactions` | The compactions that run now, from 0 to `MaxBackgroundCompactions`. |
| `rocksdb.is-write-stopped` | 1 while writes are stopped, else 0. |
| `rocksdb.actual-delayed-write-rate` | The rate in bytes per second while writes are delayed, else 0. |

## Properties that return null

| Property | Why |
| --- | --- |
| `rocksdb.block-cache-capacity`, `rocksdb.block-cache-usage`, `rocksdb.block-cache-pinned-usage` | For a column family without a `BlockCache`. RocksDB with no block cache also returns null. |
| Any other name | Not supported. |

## Memory figures

The memory figures count what the data needs, not what was allocated:

- `cur-size-all-mem-tables` counts the nodes of each memtable in its native arena: each key and value, a 24-byte header, and 8 bytes for each skip-list level, rounded up to 8. It also counts the range tombstones and their fragments. An empty memtable is 0. RocksDB counts the arena blocks that it allocated, 2 KB for an empty memtable. The arena also holds at most one partly used chunk of 64 KiB for each processor that wrote to the memtable.
- `estimate-table-readers-mem` counts the index keys and handles, the filter bits, and the range tombstones and their fragments of each open table. With `CacheIndexAndFilterBlocks`, it counts the range tombstones and their fragments only, as RocksDB leaves out the cached blocks.
