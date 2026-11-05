---
sidebar_position: 4
---

# Data Directory

A Solarium database is one directory. This page lists the files in it and what each one holds. Do not change these files by hand.

| File | Content |
| --- | --- |
| `LOCK` | An exclusive lock. Only one open database can use the directory. |
| `FORMAT` | The format version, `solarium-format 6`. |
| `MANIFEST` | The live WAL files, the column families, their SSTables with the level of each, and the flush point of each column family. |
| `NNNNNN.log` | A WAL file. |
| `NNNNNN.sst` | An SSTable. |
| `.*` | A file of an application, never of the database. See [Application files](#application-files). |

## LOCK

`LOCK` is a process lock. `Open` takes it, and `Dispose` releases it. A second `Open` of the same directory fails while the first database is open. A checkpoint also takes the `LOCK` of its directory while it writes, and the copy keeps the `LOCK` file.

`LOCK` is the only file that does not go through the storage environment.

## FORMAT

`FORMAT` holds the format version, `solarium-format 6`. Older directories move to format 6 at open:

- A format-5 directory differs from format 6 in new SSTables (table version 5, whose block checksums are bound to the table id and the block offset) and in the manifest (version 4, which records each table id). Its version 4 tables still read until a compaction rewrites them, and its version 3 manifest still loads.
- A format-4 directory differs from format 5 in new SSTables only (table version 4, with a partitioned index and filter). Its version 3 tables still read until a compaction rewrites them.
- A format-3 directory differs from format 4 in new SSTables only (table version 3, whose data blocks have a type and can be compressed). Its version 2 tables still read until a compaction rewrites them.
- A format-2 directory differs from format 3 in new WAL files only. Its WAL files still replay.
- A format-1 directory is migrated at open.

The move is one way. `Open` changes `FORMAT` first, before it reads the tables, and an older version of Solarium refuses a format that it does not know. To keep the choice to go back, copy the directory before the first open with a new version.

A checkpoint writes `FORMAT` last. So a directory that has other files but no `FORMAT` is an unfinished copy, and `Open` refuses it.

## MANIFEST

`MANIFEST` is a binary record with a CRC-32. Each change writes a new manifest and replaces the old one atomically. It holds:

- the live WAL files;
- the column families, with their names and ids;
- the SSTables of each column family, with the id and the level of each, and a flag for each table;
- the flush point of each column family: the sequence number up to which its data is in SSTables.

The current manifest is version 4, which adds the id of each table to the levels 1 to 5 and the flag for each table of version 3. A version 3, 2, or 1 manifest still loads, with its tables without an id. `Manifest` in `Engine/Manifest.cs` documents the layout.

At open, each table file must match its record: its id when the record has one, its size, its entry count, its sequence numbers, and its key range. A mismatch fails the open. See [Damage to an SSTable](../operations/durability.md#damage-to-an-sstable).

A first open writes the manifest after `FORMAT` and before any WAL or SST file. So `Open` takes a directory without a manifest as new only when it holds nothing but `LOCK`, `FORMAT`, temporary files, and application files. It refuses a directory with any other file and no manifest, because its manifest was lost. It changes nothing in that directory.

## WAL files

Each `NNNNNN.log` file is a WAL file. A new WAL file starts at the first write group after a memtable switch. The manifest lists the live WAL files, and the files that no memtable needs are deleted after a flush. [WAL and Recovery](../architecture/wal-and-recovery.md) gives the format.

## SSTables

Each `NNNNNN.sst` file is an SSTable. It never changes after the manifest names it. A file that leaves the manifest is deleted when the last version that lists it closes. [SSTables](../architecture/sstables.md) gives the format.

A checkpoint links SSTables into its copy under their own numbers.

## Application files

A file whose name starts with `.` belongs to an application. Solarium writes none, and an open neither reads nor deletes one, as RocksDB ignores the names that it does not know. So an application can keep records beside the database, and a directory whose database files were lost while those records survived opens as a new database. `SolariumWAL` keeps its [ledgers](../integrations/kommander.md#storage-damage) here.

## Orphan files

A crash during a flush or a compaction can leave SSTables that the manifest does not list. The next open deletes them.
