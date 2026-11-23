---
sidebar_position: 4
---

# Range Deletes

A range delete removes every key in a range with one write. A Raft log uses it to drop the dead prefix of the log. Millions of old entries go away with one write.

Solarium has three ways to remove a range of keys. They differ in cost and in what they guarantee. Kommander combines all three.

| Method | What it writes | When the space comes back | Guarantee |
| --- | --- | --- | --- |
| `DeleteRange` | One range tombstone | At a later compaction | Exact. Reads see no key in the range at once. |
| `DeleteFilesInRange` | One manifest save | At once, for the files that it drops | Drops a file only if all its keys are in the range. Ignores sequence numbers. |
| `CompactRange` | A rewrite of the range | When the call returns | Exact. Removes what the deletes in the range hide. |

## DeleteRange

```csharp
db.DeleteRange("log:0000"u8, "log:5000"u8);

// The same, inside a batch:
db.Write(new WriteBatch()
    .DeleteRange("log:0000"u8, "log:5000"u8, log)
    .Put("floor"u8, "5000"u8, metadata),
    WriteOptions.Synced);
```

`DeleteRange` deletes the keys in `[begin, end)`: the begin key is included and the end key is excluded. It writes one **range tombstone**. A range tombstone is a marker that hides the older versions of the keys in its range, in all older sources.

- An empty range, where `begin` equals `end`, does not write anything.
- An end key before the begin key throws `ArgumentException` when you add it to the batch.
- A put of a key in the range after the range delete is newer than the tombstone. This means that the key is visible again.

Range tombstones add little time to reads. Each read checks the tombstones that can cover its key. Solarium indexes them to make the check fast with thousands of tombstones. On the benchmark machine (a 13th Gen Intel Core i7-13620H on Linux), a `Get` in a memtable with 8,192 tombstones took 204 ns, against 164 ns with none. [Memtable](../architecture/memtable.md) explains the index.

## DeleteFilesInRange

```csharp
db.DeleteFilesInRange("log:0000"u8.ToArray(), "log:5000"u8.ToArray(), log);
```

`DeleteFilesInRange` drops, in one manifest save, the SSTables of levels 1 to 6 whose keys all lie in the range. It does not rewrite data, and a file that reaches past the range remains.

- `includeEnd` is true by default, as in the C API of RocksDB. The end key is then part of the range.
- It does not touch level 0 or the memtables. It also does not touch the files of a compaction in progress.
- It ignores sequence numbers, as in RocksDB. A key of a dropped file is gone for later reads, even when no delete was written for it.
- Reads and iterators that started before the call continue to see the dropped files.
- An older version of a key, in a lower file that reaches past the range, can come back. This cannot occur in a store whose keys are written once, such as a Raft log.

Use `DeleteFilesInRange` together with `DeleteRange`. The tombstone makes the delete exact, and the file drop gives back the space at once.

## CompactRange

```csharp
db.Flush(log);
db.CompactRange("log:0000"u8.ToArray(), "log:5000"u8.ToArray(), log);
```

`CompactRange` compacts the range one level after the other, as the manual compaction of RocksDB does. A delete in the range reaches the bottom level and drops what it hides. Pass null for an open end.

- It returns when the last compaction is installed.
- It does not flush a memtable that overlaps the range first. Call `Flush` first if the memtable has data in the range.
- It does not rewrite level 6 files alone. Only files that a level above overlaps are rewritten.

`CompactRange` can write a lot of data. Call it for maintenance tasks only.

## The Raft log pattern

Kommander removes the dead prefix of a partition log with one write batch and one file drop.

```mermaid
flowchart LR
    subgraph Batch[One write batch]
        F[Put the new floor in metadata]
        T[DeleteRange below the floor]
    end
    Batch --> M[Active memtable]
    M -- flush drops the covered entries --> S[New SSTable: live entries only]
    O[Old SSTables below the floor] -- DeleteFilesInRange --> X[Dropped with no rewrite]
```

1. Write the new compaction floor to the metadata and a range tombstone below the floor, in one batch.
2. The tombstone goes to the active memtable. When that memtable flushes, the flush drops the log rows that the tombstone covers. These rows never reach an SSTable.
3. Call `DeleteFilesInRange` below the floor. The SSTables whose last entry is below the floor go away with no rewrite.

This works well because the files of one partition do not overlap. The log ids in each file are all higher than those of the files before it. This means that compaction can move a file down with no rewrite, and the file drop can remove all of it. In the compaction benchmark, this pattern wrote zero bytes in compactions.
