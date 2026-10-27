---
sidebar_position: 7
---

# SSTables

An **SSTable** (sorted string table) is an immutable file of sorted entries. A flush or a compaction writes it once, and nothing changes it after the manifest names it. This page gives the layout of the file.

## What an SSTable holds

An SSTable stores internal keys: the user key, the sequence number, and the kind. So a read can order the versions of a key, and the range tombstones over it, across the memtables and the tables by sequence number.

It holds, in this order:

| Part | Content |
| --- | --- |
| Data blocks | The entries, in internal key order, in blocks of about 4 KB. Each block is raw or, with `ColumnFamilyOptions.Compression`, an LZ4 block. |
| Range tombstone block | The range tombstones of the table. |
| Index and filter partitions | For each run of data blocks, a filter block and an index block. The index holds the last internal key of each data block, with its offset and size. The filter is a Bloom filter on the user keys of those blocks: 10 bits for each key and 7 probes, about 1% false positives. |
| Properties block | The entry count, the lowest and highest sequence numbers, and the smallest and largest keys. |
| Top-level index | The last internal key of each partition, with the handles of its index and its filter. |
| Footer | The handles of the other blocks, the format version, a checksum, and a magic number. |

Every block and the footer carry a CRC-32.

## The layout

All integers are little-endian. A block handle is an offset and a size, and it covers the payload and the CRC-32 of the block.

```text
[data block]... [range tombstone block] ([filter partition] [index partition])... [properties block]
[top-level index] [footer]

data block      = [payload][u8 type]          type 0: payload = entry...
                                              type 1: payload = [u32 raw size][LZ4 block of entry...]
entry           = [u32 key length][key][u64 sequence][u8 kind][u32 value length][value]
range tombstone = [u32 count] ([u32 length][begin][u32 length][end][u64 sequence])...
filter          = [u32 bit count][u8 hash count][bits]     Bloom filter over the user keys of a partition
index           = [u32 count] ([u32 length][last key][u64 last sequence][u64 offset][u32 size])...
properties      = [u64 entries][u64 min sequence][u64 max sequence][u32 length][smallest][u32 length][largest]
top-level index = [u32 count] ([u32 length][last key][u64 last sequence][u64 index offset][u32 index size]
                               [u64 filter offset][u32 filter size])...
footer          = 4 handles (range tombstone, filter, properties, top-level index) as [u64 offset][u32 size],
                  then [u32 format version][u32 CRC-32 of the 52 bytes before it][u64 magic]
```

Each block is followed by the CRC-32 of its payload. A data block also has a type byte between its payload and the CRC-32, and the CRC-32 covers the type too, as the block trailer of RocksDB does. In version 4, the filter handle of the footer is (0, 0), because each partition names its own filter. The magic number is `SOLARIM1`.

`TableFormat` in `src/Solarium/Engine/TableFormat.cs` documents the exact layout.

## Notes on the format

- **Keys are stored whole.** Each key comes after 17 bytes of lengths, sequence number, and kind. RocksDB stores only the part of a key that differs from the key before it, with varint lengths. LZ4 compression gets back most of that space when keys share long prefixes.
- **Compression is for each block.** A block that LZ4 makes smaller by less than one eighth is stored raw. Only data blocks are compressed.
- **Partitions follow RocksDB.** An index partition is cut when it reaches about 4 KB of index entries, as the partitioned index of RocksDB with `metadata_block_size`.
- **The versions of one key can span blocks and partitions**, because each index holds last internal keys. A key whose versions continue into the next partition is in both filters.
- **Exclusive largest bound.** A table records when its largest bound is the end of a range tombstone that none of its entries has. Then two tables of a level can meet at that key without overlapping. See [Compaction](compaction.md#the-merge).

## Versions

| Version | Difference |
| --- | --- |
| 4 | The current version. The index and the filter are cut into partitions under a top-level index. |
| 3 | One index block and one filter block, which read as one partition. Data blocks have a type byte and can be compressed. It still reads, until a compaction rewrites it. |
| 2 | Written before data blocks had a type. Its data blocks are raw entries. It still reads, until a compaction rewrites it. |

## What an open table keeps in memory

When a table opens, it reads and verifies every partition. It keeps in memory:

- the top-level index, about 0.04% of the table bytes;
- the index and filter partitions, about 2% of the table bytes and 4% with LZ4, which shrinks the data but not the keys. With `CacheIndexAndFilterBlocks`, they go to the block cache instead;
- the range tombstones, cut into fragments that do not overlap. With 8 tombstones or fewer, it scans them instead, which costs less than the build.

Each index is decoded into a few arrays: one of the last keys laid end to end, one of where each key starts, and one each of the sequence numbers, offsets, and sizes. So an index is five objects, whatever its number of blocks. One array for each key made a long-lived object for every 4 KB of data.

`rocksdb.estimate-table-readers-mem` reports these bytes. The data blocks are read from the file on each read, through the page cache of the operating system.
