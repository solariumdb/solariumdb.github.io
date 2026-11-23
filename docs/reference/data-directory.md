---
sidebar_position: 4
---

# Data Directory

A Solarium database is one directory. This page lists the files in it and the content of each one. Do not change these files by hand.

| File | Content |
| --- | --- |
| `LOCK` | An exclusive lock. Only one open database can use the directory. |
| `FORMAT` | The format version, `solarium-format 6`. |
| `MANIFEST` | The live WAL files, the column families, their SSTables with the level of each, and the flush point of each column family. |
| `NNNNNN.log` | A WAL file. |
| `NNNNNN.sst` | An SSTable. |
| `.*` | A file that belongs to an application. Solarium writes no such file. See [Application files](#application-files). |

## LOCK

`LOCK` is a process lock. `Open` takes it, and `Dispose` releases it. A second `Open` of the same directory fails while the first database is open. A checkpoint also takes the `LOCK` of its directory while it writes, and the `LOCK` file remains in the copy.

`LOCK` is the only file that does not go through the storage environment.

## FORMAT

`FORMAT` contains the format version, `solarium-format 6`. Older directories move to format 6 at open.

- A format-5 directory differs from format 6 in new SSTables (table version 5, whose block checksums are bound to the table id and the block offset) and in the manifest (version 4, which records each table id). Its version 4 tables can be read until a compaction rewrites them, and its version 3 manifest loads.
- A format-4 directory differs from format 5 in new SSTables only (table version 4, with a partitioned index and filter). Its version 3 tables can be read until a compaction rewrites them.
- A format-3 directory differs from format 4 in new SSTables only (table version 3, whose data blocks have a type and can be compressed). Its version 2 tables can be read until a compaction rewrites them.
- A format-2 directory differs from format 3 in new WAL files only. Its WAL files can be replayed.
- A format-1 directory is migrated at open.

The move is one way. `Open` changes `FORMAT` first, before it reads the tables. An older version of Solarium cannot open a format that it does not know. To be able to go back, copy the directory before the first open with a new version.

A checkpoint writes `FORMAT` last. A directory that has other files but no `FORMAT` is an unfinished copy, and `Open` refuses it.

## MANIFEST

`MANIFEST` is a binary record with a CRC-32. Each change writes a new manifest and replaces the old one atomically. The record has four parts.

- The live WAL files.
- The column families, with their names and ids.
- The SSTables of each column family, with the id and the level of each, and a flag for each table.
- The flush point of each column family: the sequence number up to which its data is in SSTables.

The current manifest is version 4. It adds the id of each table to the levels 1 to 5 and the flag for each table of version 3. A manifest of version 1 to 3 also loads, and its tables have no id. `Manifest` in `Engine/Manifest.cs` documents the layout.

At open, each table file must match its record: its id when the record has one, its size, its entry count, its sequence numbers, and its key range. A mismatch fails the open. See [Damage to an SSTable](../operations/durability.md#damage-to-an-sstable).

A first open writes the manifest after `FORMAT` and before any WAL or SST file. If a directory has no manifest, `Open` takes it as new only when all its files are `LOCK`, `FORMAT`, temporary files, or application files. A directory with any other file lost its manifest. `Open` refuses that directory and does not change it.

## WAL files

Each `NNNNNN.log` file is a WAL file. A new WAL file starts at the first write group after a memtable switch. The manifest lists the live WAL files, and the files that no memtable needs are deleted after a flush. [WAL and Recovery](../architecture/wal-and-recovery.md) gives the format.

## SSTables

Each `NNNNNN.sst` file is an SSTable. It does not change after the manifest names it. A file that leaves the manifest is deleted when the last version that lists it closes. [SSTables](../architecture/sstables.md) gives the format.

A checkpoint links SSTables into its copy under their own numbers.

## Application files

A file whose name starts with `.` belongs to an application. Solarium writes none, and an open neither reads nor deletes one, as RocksDB ignores the names that it does not know. This means that an application can store records beside the database. If the database files are lost while those records survive, the directory opens as a new database. The [ledgers](../integrations/kommander.md#storage-damage) of `SolariumWAL` are stored here.

## Orphan files

A crash during a flush or a compaction can leave SSTables that the manifest does not list, and temporary files of the database. The next open deletes them. It does not delete a temporary file of an application, whose name starts with `.`, because the application can be in the middle of a replacement.
