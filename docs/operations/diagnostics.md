---
sidebar_position: 4
---

# Diagnostics

When writes slow down or memory grows, you need to see what the engine is doing. Solarium reports the files in each level, the memtable sizes, the pending flushes and compactions, and the write stalls. It uses the property names of RocksDB, so code that reads RocksDB properties, such as Kommander, reads Solarium too. [Properties](../reference/properties.md) lists each property.

## Read a property

```csharp
string? l0 = db.GetProperty("rocksdb.num-files-at-level0", log);
string? stopped = db.GetProperty("rocksdb.is-write-stopped");
```

`GetProperty` returns a decimal integer as a string, or null for a name that it does not support. A property of a column family uses the default column family when you pass none.

## A health check

```csharp
static void Report(SolariumDb db)
{
    foreach (ColumnFamily family in db.ColumnFamilies)
    {
        string files = string.Join(" ", Enumerable.Range(0, 7)
            .Select(level => db.GetProperty($"rocksdb.num-files-at-level{level}", family)));

        Console.WriteLine($"{family.Name}: files by level [{files}], " +
            $"base level {db.GetProperty("rocksdb.base-level", family)}, " +
            $"memtables {db.GetProperty("rocksdb.cur-size-all-mem-tables", family)} B, " +
            $"live SSTables {db.GetProperty("rocksdb.live-sst-files-size", family)} B");
    }

    Console.WriteLine($"delayed write rate {db.GetProperty("rocksdb.actual-delayed-write-rate")} B/s, " +
        $"stopped {db.GetProperty("rocksdb.is-write-stopped")}");
}
```

## What to look for

| Symptom | Property | What it means |
| --- | --- | --- |
| Writes are slow | `rocksdb.actual-delayed-write-rate` above 0 | A column family has `Level0SlowdownWritesTrigger` level 0 files. See [Write Stalls](write-stalls.md). |
| Writes hang | `rocksdb.is-write-stopped` is 1 | A column family has `Level0StopWritesTrigger` level 0 files. |
| Reads are slow | `rocksdb.num-files-at-level0` is high | Each level 0 file is one more source for each read. |
| Memory grows | `rocksdb.cur-size-all-mem-tables` | The memtables of the column family. |
| Memory grows | `rocksdb.estimate-table-readers-mem` | The index, filter, and range tombstones of the open SSTables. |
| Flushes fall behind | `rocksdb.mem-table-flush-pending` is 1 | A memtable waits for a flush that has not started. |
| Compaction falls behind | `rocksdb.compaction-pending` is 1 | A level needs a compaction. |

## Live files

```csharp
foreach (LiveFileMetaData file in db.GetLiveFilesMetaData())
    Console.WriteLine($"{file.ColumnFamilyName} L{file.Level} {file.Name} {file.Size} B " +
        $"seq {file.SmallestSequenceNumber}..{file.LargestSequenceNumber} entries {file.EntryCount}");
```

`GetLiveFilesMetaData` lists every live SSTable of every column family, in the order of the manifest: level 0 newest first, then each of levels 1 to 6 in key order. Each entry has:

- the column family, the level, the file name (with a leading slash, as RocksDB gives it: `/000012.sst`), and the file number;
- the size in bytes;
- the smallest and largest user keys. The largest key can be the exclusive end of a range tombstone;
- the lowest and highest sequence numbers;
- the point entries: puts and deletes.

The keys are copies that belong to you.

## Metrics for Kommander

`SolariumWAL` publishes the engine metrics of Kommander on the `"Solarium.Kommander"` meter. See [Solarium.Kommander metrics](../integrations/kommander.md#metrics).

## Memory figures differ from RocksDB

- `cur-size-all-mem-tables` counts the keys and values of each memtable, plus 32 bytes for each entry, and the fragments of its range tombstones. An empty memtable is 0. RocksDB counts the arena blocks that it allocated, 2 KB for an empty memtable.
- `estimate-table-readers-mem` counts the index keys and handles, the filter bits, and the range tombstones and their fragments of each open table. It does not count allocations.
- `block-cache-usage` and `block-cache-pinned-usage` return null, as in RocksDB with no block cache.
