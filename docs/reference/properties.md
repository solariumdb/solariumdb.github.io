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
| `rocksdb.estimate-table-readers-mem` | The bytes that the open SSTables keep in memory: index, filter, and range tombstones. |
| `rocksdb.live-sst-files-size` | The bytes of the SSTables of the current version. |
| `rocksdb.num-files-at-level0` to `rocksdb.num-files-at-level6` | The SSTables in each level. |
| `rocksdb.base-level` | The level that level 0 compacts into. |
| `rocksdb.compaction-pending` | 1 when a level needs a compaction, else 0. That is, level 0 holds `Level0FileNumCompactionTrigger` files, or a sorted level above the bottom holds more than its target. The files that a compaction reads do not count. |

## Properties of the database

These are the same for every column family.

| Property | Value |
| --- | --- |
| `rocksdb.num-running-flushes` | 0 or 1. There is one flush thread. |
| `rocksdb.num-running-compactions` | 0 or 1. There is one compaction thread. |
| `rocksdb.is-write-stopped` | 1 while writes are stopped, else 0. |
| `rocksdb.actual-delayed-write-rate` | The rate in bytes per second while writes are delayed, else 0. |

## Properties that return null

| Property | Why |
| --- | --- |
| `rocksdb.block-cache-usage` | There is no block cache. RocksDB with no block cache also returns null. |
| `rocksdb.block-cache-pinned-usage` | There is no block cache. |
| Any other name | Not supported. |

## Memory figures

The memory figures count what the data needs, not what was allocated:

- `cur-size-all-mem-tables` counts the keys and values of each memtable, plus 32 bytes for each entry, and the fragments of its range tombstones. An empty memtable is 0. RocksDB counts the arena blocks that it allocated, 2 KB for an empty memtable.
- `estimate-table-readers-mem` counts the index keys and handles, the filter bits, and the range tombstones and their fragments of each open table.
