---
sidebar_position: 1
---

# Durability

This page tells you what a write survives, and what the database does at open after a crash or a power loss. [WAL and Recovery](../architecture/wal-and-recovery.md) explains the file format and the exact rules.

## What a write survives

| Event | Synced write | Unsynced write |
| --- | --- | --- |
| Process crash, after `Write` returns | Survives | Survives |
| Power loss, after `Write` returns | Survives | Can be lost |
| Power loss, after a clean `Dispose` | Survives | Survives |
| Crash during `Write` | The batch is there whole, or not at all | The batch is there whole, or not at all |

The reasons:

- A **synced** write (`WriteOptions.Sync`) flushes the WAL to the device before `Write` returns.
- An **unsynced** write is in the WAL file in the operating system when `Write` returns. The operating system keeps it when the process dies, but a power loss can lose it. This is the same as in RocksDB.
- `Dispose` flushes the current WAL file. So after a clean close, every write survives a power loss. RocksDB does not do this: its unsynced writes need `SyncWAL` before the close.
- A batch is one WAL record with a checksum. Recovery replays a record whole, or drops it whole.

## A crash and a power loss are different

- A **process crash** can only cut the last write short. The operating system keeps everything else that the process wrote.
- A **power loss** can lose any sector written since the last flush, in any order. So the newest WAL file can end with damage that has intact records after it.

Solarium tells these two cases apart. Each WAL record carries the **durable offset** of its file: how much of the file a completed flush made durable when the record was appended.

## What recovery does at open

1. Every WAL file replays in order. Entries that an SSTable already holds are skipped.
2. A memtable that fills during the replay is written as a level 0 SSTable at once. So the WAL files do not need to fit in memory.
3. The newest WAL file is cut at its first damage, with everything after it, unless an intact record after the damage has a durable offset past it.
4. If that record exists, it proves that the damaged bytes were flushed. No crash explains that damage, so the open fails and does not drop data.
5. A new WAL file starts.

The open also fails, and changes nothing, when it finds:

- damage in an older WAL file;
- a gap in the sequence numbers;
- a WAL file that the manifest lists but that does not exist;
- a directory with data files but no `MANIFEST`.

A crash during a flush or a compaction leaves orphan files. The next open deletes them.

## The one case that can drop a synced write

The cut can drop a synced write only in one case: flushed data was damaged in a way that no crash causes, and no record was written after it. That is damage inside the last synced group of the file, with nothing appended since. Then nothing in the file shows that the group was flushed.

RocksDB has two recovery modes for this case:

- `TolerateCorruptedTailRecords`, which Kommander uses, fails the open after any power loss that left such a hole.
- `PointInTimeRecovery` drops everything after the first damage, whatever its cause.

Solarium opens after every kind of power loss that its tests simulate, and fails only on damage that no crash explains.

## After a failure while running

A WAL, flush, or compaction failure stops all later writes until you open the database again. After a failed append, the tail of the WAL is unknown, so the database does not write after it. Reads continue. See [Storage Failures](storage-failures.md).

## How it is tested

The [power-loss tests and the kill tests](testing.md) check these rules. They cut the power or kill a process at random points of a random workload, reopen the database, and check that it holds exactly the batches that it must hold.
