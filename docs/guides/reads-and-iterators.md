---
sidebar_position: 3
---

# Reads and Iterators

Reads in Solarium take no engine locks. Each write gets a **sequence number**, a counter that only grows. Each read sees the database at one sequence number, so it never sees part of a batch. This guide explains point reads, iterators, upper bounds, and how long an iterator keeps its snapshot.

## Point reads

```csharp
byte[]? value = db.Get("user:42"u8);
byte[]? inFamily = db.Get("user:42"u8, users);
```

`Get` returns the newest value of the key, or null when the key is absent or deleted. The array belongs to you, so you can keep it or change it.

`MultiGet` reads several keys of one column family at one snapshot:

```csharp
byte[]?[] values = db.MultiGet(keys, users);
```

The result has one entry for each key, in the same order. To read keys of several column families, call `MultiGet` once for each column family.

`MultiGet` costs less than one `Get` for each key. It finds the data block of every key first, and then reads the distinct blocks together, in one batch read of the storage environment. Keys often share a block. On io_uring, the reads that miss the page cache are in flight together. See [Read Path](../architecture/read-path.md#multiget).

With a [block cache](memory.md), `ReadOptions.FillCache` decides whether a read caches the blocks that it reads from the file: the data blocks with `CacheDataBlocks`, and the index and filter partitions that the cache evicted. Set it to false for a read of rows that you will not read again:

```csharp
byte[]? value = db.Get("user:42"u8, users, new ReadOptions { FillCache = false });
```

## Snapshots

A read takes the current version of the column family, then the latest published sequence number as its snapshot. It sees every write at or below that sequence number, and no write above it.

- A batch becomes visible to reads all at once, when its `Write` returns.
- A read never sees part of a batch.
- A read that starts after a `Write` returns sees that write.

`db.LatestSequenceNumber` gives the sequence number of the newest write that reads can see. Each operation of a batch takes one sequence number.

## Iterators

An iterator is an ordered cursor over one column family at one snapshot:

```csharp
using Iterator iterator = db.NewIterator(users);

for (iterator.SeekToFirst(); iterator.Valid(); iterator.Next())
{
    ReadOnlySpan<byte> key = iterator.Key();
    ReadOnlySpan<byte> value = iterator.Value();
}
```

| Member | What it does |
| --- | --- |
| `SeekToFirst()` | Moves to the first key, or becomes invalid when there is none. |
| `Seek(target)` | Moves to the first key at or after `target`. |
| `SeekToLast()` | Moves to the last key, or to the last key before the upper bound. |
| `Next()` | Moves to the next key. |
| `Prev()` | Moves to the previous key. |
| `Valid()` | True when the iterator is on a key. |
| `Key()`, `Value()` | The current key and value, valid until the iterator moves. They throw `InvalidOperationException` when the iterator is not valid. |
| `Dispose()` | Releases the snapshot and its SSTables. Later calls do nothing. |

Keys sort by their bytes, as unsigned values. Each position is the newest version of a key at or below the snapshot. Deleted keys and keys under a range tombstone do not show.

The spans from `Key()` and `Value()` are valid only until the next `Seek`, `Next`, `Prev`, or `Dispose`, as in RocksDB. The iterator copies each position into buffers that it reuses, so `Next` allocates nothing. To keep a key or a value after the iterator moves, copy it:

```csharp
List<byte[]> keys = new();

for (iterator.SeekToFirst(); iterator.Valid(); iterator.Next())
    keys.Add(iterator.Key().ToArray());
```

## Upper bounds

`ReadOptions.IterateUpperBound` stops the iterator before the first key at or after the bound:

```csharp
ReadOptions options = new() { IterateUpperBound = "user;"u8.ToArray() };

using Iterator iterator = db.NewIterator(users, options);
for (iterator.Seek("user:"u8); iterator.Valid(); iterator.Next())
{
    // Only keys that start with "user:".
}
```

To read one prefix, set the bound to the prefix with its last byte increased by one. In this example, `;` is the byte after `:`.

An upper bound also makes `SeekToLast` start at the last key before the bound.

## Backward iteration costs more

`Next` merges one cursor for each source (each memtable and each SSTable level). It moves each cursor past the current key. `Prev` asks each source for its largest key below the current key, and then looks up the winner. So one `Prev` step searches every source, and it is slower than `Next`. Prefer forward scans. When you need the last N keys of a range, `SeekToLast` and a few `Prev` steps are fine.

## Iterator lifetime

An iterator keeps the version of its creation. Until you dispose it:

- it does not see later writes;
- it does not see later flushes and compactions;
- it keeps the SSTables of that version open, even when compaction replaces them.

A file that compaction removed from the manifest is deleted only after the last version that lists it closes. So an iterator that you forget to dispose keeps old SSTables on disk. Always dispose iterators, and do not keep them for a long time.

Use one iterator from one thread at a time. You can create many iterators at the same time from different threads.

## Reads after a failure

After a WAL, flush, or compaction failure, writes stop, but reads continue. A read sees the data up to the last published write.
