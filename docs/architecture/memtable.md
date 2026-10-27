---
sidebar_position: 4
---

# Memtable

The **memtable** is the in-memory table of one column family. It holds the newest writes until a flush writes them to an SSTable. This page explains the skip list, how concurrent writers insert into it, and how it indexes range tombstones.

## A multi-version skip list

The memtable is a **skip list**: a sorted linked list with extra levels of links that skip ahead, so a search takes about log n steps. It holds entries in internal key order: the user key first, then the sequence number from the newest to the oldest. Each version of a key is its own entry.

The memtable follows the LevelDB design:

- Any number of readers walk the list with no lock.
- A node is fully built before a release-store or a compare-and-swap links it in.
- Nodes are never removed while the memtable lives. So a reader can walk the list while writers insert.

A reader sees a consistent state through sequence numbers, not through the list. The database publishes the last sequence number of a group only after every entry of the group is in. A reader skips entries newer than its snapshot.

## Concurrent inserts

The memtable takes either one writer at a time, or the writers of one group at once, never both:

- **One writer** links each new node in with a release-store.
- **Several writers** each link their own nodes with a compare-and-swap at each level, from the bottom level up. When a link changed under a writer, it searches only that level again. This is how the `InlineSkipList::InsertConcurrently` of RocksDB works.

In a group of several writers, the leader tells each writer that still spins to insert its own batch. It inserts the batches of the writers that blocked. A blocked writer would need to wake and get a CPU before it could insert, and that would delay the whole group. See [Write Path](write-path.md).

## Memory

The memtable is on the managed heap. Its size counts the keys and values, plus 32 bytes for each entry, plus the fragments of its range tombstones. When the size reaches `WriteBufferSize`, the memtable becomes immutable at the next write group. A `WriteBufferManager` counts the same size, across databases. After the inserts of each group, the leader of the stage charges the bytes that the group added, once for each group and not for each entry.

A memtable that copied its keys and values into chunks on the pinned object heap, as the arena of RocksDB does, was tested. It made `Put` 4% to 9% faster under the workstation GC, and up to 12% slower under the server GC. The memtable does not use such an arena.

## Range tombstones

A **range tombstone**, from `DeleteRange`, hides every older version of the keys in its range. A read of a key must find the tombstones that cover it. With many tombstones, a scan of all of them is slow. RocksDB and Solarium both cut the tombstones into **fragments**: ranges that do not overlap, each with the sequence numbers of the tombstones over it. A read does a binary search for the fragment of its key, then takes the highest sequence number at or below its snapshot.

```mermaid
flowchart TB
    subgraph T[Tombstones]
        T1["[b, f) at seq 10"]
        T2["[d, h) at seq 20"]
    end
    subgraph F[Fragments]
        F1["[b, d): 10"]
        F2["[d, f): 20, 10"]
        F3["[f, h): 20"]
    end
    T --> F
```

### In the memtable: runs that double

The tombstones of a memtable change with each range delete. RocksDB caches the fragments of all of them until the next range delete, so the first read after each range delete fragments them all again. With 8,192 tombstones, that read pays for 8,192 tombstones.

Solarium makes the writer build the fragments instead, in **runs**:

1. Range tombstones go into an array that only grows. Each range delete publishes a new set over a longer prefix of the array, so the set that a reader holds never changes.
2. When 8 tombstones are past the last run, the writer builds them into a new run.
3. It merges into the new run the runs before it that are no larger, as a binary counter carries.
4. So the runs have sizes of 8, 16, 32, and more tombstones, one of each size at most.

A lookup searches each run with a binary search, and scans the fewer than 8 tombstones past the last run. No reader builds anything.

The cost moves to the writer: each tombstone takes part in one build each time the count of tombstones doubles. The largest build, of all the tombstones, comes on the range delete that makes the count 8 times a power of two.

In the benchmarks, a pair of one `DeleteRange` and one `Get` costs 4 to 9 µs at every tombstone count. With the RocksDB approach, it cost 2,006 µs at 8,192 tombstones.

### Concurrent range deletes

When several writers of a group add range deletes at once, the range deletes go to a copy-on-write array under a small lock, not to a second skip list.

## After a flush

A flush writes only the newest version of each key, and drops a key that a newer range tombstone of the same memtable covers. So entries that die while still in memory never reach an SSTable. See [Flushes](flushes.md).
