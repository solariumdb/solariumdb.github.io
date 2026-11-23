---
sidebar_position: 5
---

# Storage Failures

A disk can fill up, a volume can go read-only, and a device can return an I/O error. This page explains what Solarium does after such a failure, and what you should do.

## Writes stop after a failure

A WAL failure stops all later writes until you open the database again. A flush failure and a compaction failure have the same effect.

- Each later `Write` throws `SolariumException`.
- `Flush`, `CompactRange`, `DeleteFilesInRange`, and `CreateCheckpoint` also throw `SolariumException`.
- Reads continue. They see the data up to the last published write.

After a failed WAL append, the tail of the WAL is unknown. A part of the record can be on disk. A later append after that part would make a WAL that recovery cannot read safely. When you open the database again, recovery cuts the tail at a known point.

A failed memtable insert has the same effect. The group is complete in the WAL, but a part of it is in the memtables under sequence numbers that were not published.

## What to do

1. Find and fix the cause, for example free disk space.
2. Dispose the database.
3. Open it again. Recovery replays the WAL and cuts a torn tail.
4. Retry the writes that failed. A write that threw was not acknowledged. After the reopen, it may or may not be in the database.

All acknowledged writes are there after the reopen. Synced writes were flushed, and unsynced writes reached the operating system.

## SolariumWAL and the Kahuna store reopen on their own

`SolariumWAL` (the Kommander WAL) and the store of `Solarium.Kahuna` do the reopen for you, except after [corruption](#corruption). After a failure, `SolariumWAL` checks the volume and the database before it decides to reopen.

1. It writes a small probe file through the storage environment, to check that the volume takes a durable write.
2. It writes a canary put, to check whether the database takes a write.
3. When the volume takes the write and the database does not, it closes the database and opens it again. Then it retries the operation once. In all other cases, it does not reopen.

Until the volume takes writes again, the result of a write is `Errored`, and Kommander retries on its own cadence. The counter `raft.wal.engine_reopens_total` counts the reopens, tagged `success` or `failed`. For more information, see [Solarium.Kommander](../integrations/kommander.md#after-a-storage-failure).

## Corruption {#corruption}

Corruption is damage to the files of the database that no crash explains. The damage can be in a table, the WAL, or the manifest. An operation that finds it throws `SolariumException`. The `IsCorruption` property of the exception tells you what to do.

| `IsCorruption` | Cause | What to do |
| --- | --- | --- |
| False | A failure of the storage, such as a full disk | Fix the cause and open the database again. |
| True | Damage to the files | A retry fails the same way, and a reopen does not repair the files. Take the data from another copy, for example a checkpoint or another node. |

A read that finds corruption fails, and other keys can be read. A compaction that finds it stops writes, as any compaction failure does. The exception of a later write has `IsCorruption` set too, and you can see the damage there. See [Damage to an SSTable](durability.md#damage-to-an-sstable).

The Kommander and Kahuna adapters fail-stop on corruption. They do not reopen, and all later writes fail. The node leaves consensus. See [Storage damage in SolariumWAL](../integrations/kommander.md#storage-damage) and [in the Kahuna store](../integrations/kahuna.md#storage-damage).

## Dispose after a failure

`Dispose` flushes the current WAL file. The database closes even if that flush fails. In that case, `Dispose` throws `SolariumException`, and a power loss can lose the writes since the last synced write.

## Not done yet

Solarium needs a reopen after each failure that stops writes. RocksDB can resume after some background errors while the database is open. Solarium cannot do this yet.
