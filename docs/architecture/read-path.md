---
sidebar_position: 3
---

# Read Path

A read in Solarium takes no engine locks. It takes the current version of the column family and a snapshot, and then searches the sources of the version from the newest to the oldest. This page explains why that gives a correct answer, and how readers keep files alive.

## Version, then snapshot

A read takes the version before the snapshot, as in RocksDB.

1. The **version** of the column family: the memtables and SSTables that it searches.
2. The **snapshot**: the last published sequence number.

A version never loses data that its snapshot can see. A newer version can lose it, because a compaction installed later can drop old versions of keys. For this reason, the read takes the version first, and only then a snapshot that is at least as new.

The snapshot can be newer than the memtables of the version. That is safe: a memtable switch splits the sequence numbers at one point. Entries above the snapshot are skipped, and entries at or below it are all in the version. This means that the read sees the state at one sequence number.

## Search order

A read searches the sources of the version, newest first.

```mermaid
flowchart LR
    A[Active memtable] --> I[Immutable memtables]
    I --> L0[Level 0 SSTables, newest first]
    L0 --> L1[Level 1]
    L1 --> Ln[...]
    Ln --> L6[Level 6]
```

- Each memtable is one source.
- Level 0 files can overlap, and each level 0 SSTable is one source.
- Each of levels 1 to 6 that has files is one source. The files of such a level are in key order and do not overlap. A read does a binary search for the one file that can hold the key.

Within one column family, for each key, every version of the key in a newer source has a higher sequence number than every version in an older source. The same is true of the range tombstones over the key. This means that **the first source with a version of the key decides the result**.

- For a put, the read returns its value.
- For a delete, or a range tombstone that covers the key, the read returns null.

In each source, the read skips versions and range tombstones above its snapshot.

## Index partitions and Bloom filters

Each SSTable cuts its index into partitions of about 4 KB of index entries. Each partition has a Bloom filter on the user keys of its data blocks: 10 bits for each key and 7 probes, which gives about 1% false positives. A small top-level index lists the last key of each partition.

A lookup in a table starts at the top-level index.

1. It searches the top-level index for the partition whose last key is at or after its key.
2. It checks the filter of that partition. A key that is not in the table usually stops here, with no block read.
3. It searches the index of the partition for the data block, and reads the block.

Without a block cache, the partitions stay in memory while the table is open. With `CacheIndexAndFilterBlocks`, they are in the block cache (see [Caches](#caches)).

## MultiGet

`MultiGet` reads in rounds, as the batched `MultiGet` of RocksDB, over batches of up to 32 keys.

1. A round searches the sources of each key from where it stopped. It stops when a memtable answers, or when a table index names the data block that would hold the key.
2. It reads the distinct blocks of the round, which keys often share, in one `IStorageEnvironment.MultiRead`.
3. It settles each key that its block has a version of. A key whose block has none, after a false positive of a Bloom filter, goes on to the next source in the next round.

Most calls take one round. On io_uring, the reads that the page cache misses are in flight together, and the drive serves them at once. See [Storage Environments](storage-environments.md#batch-reads).

## Iterators

An iterator merges one cursor for each source.

- **Forward.** Each step takes the smallest key under any cursor, and moves all cursors past it. The step skips deleted keys, keys under a range tombstone, and versions above the snapshot.
- **Backward.** Each step asks each source for its largest key below the current key, and looks up the winner. A step costs one search for each source, and `Prev` is slower than `Next`.

A cursor over a table reads keys and values where they are in a data block. The block is in the cache, with a reference that the cursor took, or in a buffer of the cursor. The cursor gives the block back when it moves to the next block, when it passes its last entry, and when the iterator is disposed. This means that a step of a scan allocates nothing.

Once the reads of a cursor follow one another, it reads ahead, as the iterators of RocksDB do. From the third block in a row, a read takes 8 KiB, and each read after it takes twice as many, up to 256 KiB. A seek to another place starts again with single blocks. An iterator asks only the sources that hold a range tombstone whether one covers a key. When a store does not have range tombstones, a step asks no source.

An iterator uses the snapshot and the version of its creation. A later flush or compaction does not change what it sees. The SSTables of that version stay open until you dispose the iterator.

## Reader counts

A reader counts itself into the version that it reads, and out when it is done. An iterator counts itself out when you dispose it.

- A table is closed when the last version that lists it is replaced and its last reader is done.
- A file that left the manifest is deleted when the last version that lists it closes. That can happen on the thread of the last reader.
- The counts are kept for each CPU. Readers on different CPUs do not share a cache line, and do not slow each other down.

The read takes no lock to get its version. It reads the current version with a volatile read, counts itself in with an atomic operation, and checks that the version is current. If a new version replaced it in that time, the read counts itself out and tries again.

## Caches

**Data blocks** go to the block cache of the column family only with `CacheDataBlocks`, which is off by default. When it is off, each data block that a read needs is read from the file through the storage environment, and the page cache of the operating system is the only cache. A compressed block is decompressed on each read. In the Kahuna benchmarks, with the tables in the page cache, reads were as fast as RocksDB with its block cache, or faster. See [Benchmarks](../operations/benchmarks.md).

`CacheDataBlocks` puts the data blocks that reads use in the block cache.

- A read looks up the block in the cache, keyed by the owner number of the database, the number of the table, and the offset of the block. A cached block needs no system call and no decompression.
- A miss reads, verifies, and decompresses the block, then caches it in native memory, unless `ReadOptions.FillCache` is false.
- A read holds a reference to the cached block from its lookup to the end of its decode. An eviction leaves the bytes to the last reader, which frees them. This means that the memory of a block is not freed while a read uses it.
- `Get`, iterators, and the rounds of `MultiGet` use the cache. In a `MultiGet` round, a cached block settles its keys and does not join the `MultiRead` of the round.
- Compactions read with `FillCache` off. Their inputs do not push out the blocks of the readers.
- The data blocks of a retired table stay until the LRU evicts them. A database that closes erases all entries under its owner number.

**Index and filter partitions** go to the block cache of the column family with `CacheIndexAndFilterBlocks`.

- A table puts all its partitions in the cache when it opens. The table itself has only its top-level index.
- A lookup takes its partition from the cache, under the lock of one shard.
- After an eviction, a lookup reads the two blocks of the partition again from the file, verifies them, and caches them, unless `ReadOptions.FillCache` is false.
- An eviction does not take a partition from a reader that has it. The blocks of a table never change, and the garbage collector frees them after the last reader. This means that a read does not need a reference in the cache.
- With `PinL0FilterAndIndexBlocksInCache`, a level 0 table pins its partitions until a move takes it out of level 0.
- A table that closes erases its partitions. This means that all the partitions in a cache that several databases share belong to open tables.

Each shard of the cache has a high-priority pool, up to `HighPriorityPoolRatio` of the shard, for the index and filter partitions and each entry read again after its insert. The rest is in a low-priority pool. An entry that overflows the high-priority pool moves to the newest end of the low-priority pool, and the two share one LRU order. An eviction takes from the low-priority pool first. This means that the blocks of a scan, each read once, do not push out the indexes or the blocks read often.

See [Block Cache and Memtable Budget](../guides/memory.md).
