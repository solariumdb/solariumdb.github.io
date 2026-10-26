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
| Filter block | A Bloom filter on the user keys: 10 bits for each key and 7 probes, about 1% false positives. |
| Properties block | The entry count, the lowest and highest sequence numbers, and the smallest and largest keys. |
| Index block | The last internal key of each data block, with its offset and size. |
| Footer | The handles of the other blocks, the format version, a checksum, and a magic number. |

Every block and the footer carry a CRC-32.

## The layout

All integers are little-endian. A block handle is an offset and a size, and it covers the payload and the CRC-32 of the block.

```text
[data block]... [range tombstone block] [filter block] [properties block] [index block] [footer]

data block      = [payload][u8 type]          type 0: payload = entry...
                                              type 1: payload = [u32 raw size][LZ4 block of entry...]
entry           = [u32 key length][key][u64 sequence][u8 kind][u32 value length][value]
range tombstone = [u32 count] ([u32 length][begin][u32 length][end][u64 sequence])...
filter          = [u32 bit count][u8 hash count][bits]     Bloom filter over user keys
properties      = [u64 entries][u64 min sequence][u64 max sequence][u32 length][smallest][u32 length][largest]
index           = [u32 count] ([u32 length][last key][u64 last sequence][u64 offset][u32 size])...
footer          = 4 handles (range tombstone, filter, properties, index) as [u64 offset][u32 size],
                  then [u32 format version][u32 CRC-32 of the 52 bytes before it][u64 magic]
```

Each block is followed by the CRC-32 of its payload. A data block also has a type byte between its payload and the CRC-32, and the CRC-32 covers the type too, as the block trailer of RocksDB does. The magic number is `SOLARIM1`.

`TableFormat` in `src/Solarium/Engine/TableFormat.cs` documents the exact layout.

## Notes on the format

- **Keys are stored whole.** Each key comes after 17 bytes of lengths, sequence number, and kind. RocksDB stores only the part of a key that differs from the key before it, with varint lengths. LZ4 compression gets back most of that space when keys share long prefixes.
- **Compression is for each block.** A block that LZ4 makes smaller by less than one eighth is stored raw. Only data blocks are compressed.
- **The versions of one key can span blocks**, because the index holds the last internal key of each data block.
- **Exclusive largest bound.** A table records when its largest bound is the end of a range tombstone that none of its entries has. Then two tables of a level can meet at that key without overlapping. See [Compaction](compaction.md#the-merge).

## Versions

| Version | Difference |
| --- | --- |
| 3 | The current version. Data blocks have a type byte and can be compressed. |
| 2 | Written before data blocks had a type. Its data blocks are raw entries. It still reads, until a compaction rewrites it. |

## What an open table keeps in memory

When a table opens, it reads into memory:

- the index;
- the Bloom filter;
- the range tombstones, cut into fragments that do not overlap. With 8 tombstones or fewer, it scans them instead, which costs less than the build.

`rocksdb.estimate-table-readers-mem` reports these bytes. The data blocks are read from the file on each read, through the page cache of the operating system.
