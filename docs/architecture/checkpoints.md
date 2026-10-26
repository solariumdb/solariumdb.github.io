---
sidebar_position: 9
---

# Checkpoints

`CreateCheckpoint` writes a copy of the database to a new directory, as of one sequence number in every column family. The writes to the source continue during the copy. This page explains how the copy stays consistent and how it handles crashes, races, and `Dispose`. [Checkpoints](../guides/checkpoints.md) in the guides shows how to use them.

## The steps

1. **Take the directory.** The checkpoint takes the `LOCK` of the new directory, as `Open` does. It goes on only when the directory holds nothing else.
2. **Take the snapshot.** Under the state lock, it reads the latest published sequence number. It counts itself into the current version of each column family. Every memtable switch, flush install, and compaction install happens under this lock, so the versions and the number match. The tables of those versions stay open, and their files stay in place, whatever flushes and compactions do next.
3. **Write the memtables.** Outside the lock, for each column family, it writes a level 0 table from each memtable of the version. Each table holds what a read at the sequence number sees: the entries at or below the number, newest version of each key first, and the range tombstones at or below it.
4. **Link the tables.** It links the tables of every level of the version into the copy, under their own numbers and levels.
5. **Write the manifest.** The manifest of the copy lists those tables, no WAL file, and every column family as flushed up to the sequence number. So the copy opens with nothing to replay, and numbers its own writes past that number. The save of the manifest flushes the directory.
6. **Write FORMAT.** `FORMAT` is the last file.

The memtables of the source take writes in the meantime. Their newer entries are above the sequence number, so they stay out of the copy.

## Why a link is safe

A table file is never written after a manifest names it, and a delete removes only one name. So the copy and the source share the file safely. When the source deletes the file after a compaction, the copy keeps it.

When the file system refuses a link, `IStorageEnvironment.TryLinkFile` returns false. That happens across file systems, or on a file system with no hard links. Then the checkpoint copies that table and every later one.

## Crashes and failures

- `FORMAT` is the last file. A directory that lacks it holds an unfinished copy, and `Open` refuses it.
- A failure deletes the files written, and leaves the directory with its `LOCK` file only.
- A failure does not stop the writes of the source.

## Races for the directory

The check that the directory does not exist comes first, and its creation comes later. Another checkpoint, or an `Open`, can take the directory between them. So the checkpoint takes the `LOCK` of the directory and goes on only when the directory holds nothing else. It keeps the lock until the copy is complete or deleted. The copy keeps the `LOCK` file.

A checkpoint that loses the directory fails without touching a file in it.

## Dispose during a checkpoint

`Dispose` tells a running checkpoint to stop, and waits for it before it closes the tables that the checkpoint reads.

The checkpoint checks for a stop:

- before each file and each link;
- between the chunks of a table that it copies;
- before `MANIFEST` and before `FORMAT`.

A check that finds the database closing deletes what the copy wrote, and fails with `ObjectDisposedException`. A checkpoint that is past its check before `FORMAT` completes, and `Dispose` returns after it.

## How it is tested

`CheckpointTests` holds a checkpoint at its first write and writes, flushes, and compacts the source in the meantime. The copy must read as the source did when the checkpoint began. Other tests check the order of the durable files, the races for the directory, and `Dispose` at each step. See [Testing](../operations/testing.md#checkpoint-tests).
