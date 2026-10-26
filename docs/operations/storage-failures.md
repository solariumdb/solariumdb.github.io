---
sidebar_position: 5
---

# Storage Failures

A disk can fill up, a volume can go read-only, and a device can return an I/O error. This page explains what Solarium does after such a failure, and what you must do.

## Writes stop after a failure

A WAL, flush, or compaction failure stops all later writes until you open the database again:

- Each later `Write` throws `SolariumException`.
- `Flush`, `CompactRange`, `DeleteFilesInRange`, and `CreateCheckpoint` also throw `SolariumException`.
- Reads continue. They see the data up to the last published write.

The reason: after a failed WAL append, the tail of the WAL is unknown. A part of the record can be on disk. A later append after that part would make a WAL that recovery cannot read safely. A reopen runs recovery, which cuts the tail at a known point.

A failed memtable insert has the same effect. The WAL holds the whole group, but a part of it is in the memtables under sequence numbers that were never published.

## What to do

1. Find and fix the cause, for example free disk space.
2. Dispose the database.
3. Open it again. Recovery replays the WAL and cuts a torn tail.
4. Retry the writes that failed. A write that threw was not acknowledged, so it may or may not be in the database after the reopen.

Nothing that was acknowledged is lost. Synced writes were flushed, and unsynced writes reached the operating system.

## SolariumWAL reopens on its own

`SolariumWAL`, the Kommander WAL, does the reopen for you. After a failure:

1. It writes a small probe file through the storage environment, to check that the volume takes a durable write.
2. It writes a canary put, to check whether the database takes a write.
3. Only when the volume takes the write and the database does not, does it close the database and open it again. Then it retries the operation once.

While the volume still refuses writes, every write reports `Errored`, and Kommander retries on its own cadence. The counter `raft.wal.engine_reopens_total` counts the reopens, tagged `success` or `failed`. See [Solarium.Kommander](../integrations/kommander.md#after-a-storage-failure).

## Dispose after a failure

`Dispose` flushes the current WAL file. If that flush fails, the database closes anyway, and `Dispose` throws `SolariumException`. Then the writes since the last synced write may not survive a power loss.

## Not done yet

Recovery from a WAL, flush, or compaction failure without a reopen is not done yet. RocksDB can resume after some background errors without a reopen. Solarium always needs one.
