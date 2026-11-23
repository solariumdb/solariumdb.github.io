---
sidebar_position: 8
---

# WAL and Recovery

The **write-ahead log** (WAL) is a file that only grows. Every write goes to it before it goes to a memtable. All column families share it, and one record is one complete batch. After a crash, the open replays the WAL to rebuild the memtables. This page gives the format and the exact rules of recovery. [Durability](../operations/durability.md) gives the summary.

## WAL files

- A new WAL file starts at the first write group after a memtable switch.
- The old file is flushed first. So only the newest file can have a torn tail.
- The manifest lists the live WAL files. A flush drops the WAL files that no memtable needs.
- The header of a new file is written and flushed when the file is created, before any record.

## The format

All integers are little-endian. One record is one batch.

```text
file      = [u32 magic "SWAL"][u32 version = 2][record]...
record    = [u32 payload length][u32 CRC-32 of payload][payload]
payload   = [u64 first sequence number][u64 durable offset][u32 operation count][operation]...
operation = [u8 kind = 2][u32 family id][u32 key length][key]                          delete
          | [u8 kind = 1 or 3][u32 family id][u32 key length][key][u32 length][bytes]  put, delete range (bytes = end key)
```

- Operation `i` of a batch has the sequence number `first + i`.
- Kind 1 is a put, kind 2 a delete, and kind 3 a range delete, whose bytes are the end key.
- A WAL file of version 1, from format 2, does not have a header or a durable offset. Recovery can replay it.

## The durable offset

The **durable offset** of a record is how much of the file a completed flush made durable when the record was appended. A synced group raises it for the records after it. The flush of the WAL before a memtable flush raises it too.

The durable offset lets recovery tell a power loss from damage that no crash can cause. The WAL of RocksDB has no such field.

## What a crash can do to the WAL

- A **process crash** can only cut the last write short.
- A **power loss** can also lose any sector written since the last flush, in any order. So the newest WAL file can end with damage that has intact records after it.

## Recovery rules

At open, all the WAL files replay in order. Entries that are already in an SSTable are skipped. A memtable that fills during the replay is written as a level 0 table at once. This means that the WAL files do not need to fit in memory.

For damage in the **newest** file, the durable offsets decide the result.

1. The file is cut at its first damage, with everything after it.
2. Exception: when an intact record after the damage has a durable offset past the damage, that record proves that the damaged bytes were flushed. No crash explains that damage. The open fails, and drops no data.

The open also fails for other damage that no crash explains.

- damage in an **older** WAL file;
- a **gap** in the sequence numbers;
- a WAL file that the manifest lists but that is **missing**;
- **too many bad records** after the damage. A record can start at any byte after the damage, and the search for an intact record has a limit: it checksums at most four times the bytes after the damage, plus 64 MiB. A crash does not leave more records with bad checksums than that.

A version 1 file uses the rule that it was written under: any damage with data after it, other than the end of a record or zeros, fails the open.

At the end of the open, a manifest save records the tables that the replay wrote, and a new WAL file starts.

## Damage in the last synced group

The cut can drop a synced write only when flushed data was damaged in a way that no crash causes, and no record was written after it. That is damage to the last synced group of the file, and the file ends there. In that case, no later record shows that the group was flushed.

Two recovery modes of RocksDB apply to this case.

| Mode | Behavior |
| --- | --- |
| `TolerateCorruptedTailRecords` | The mode that Kommander uses. It fails the open after any power loss that left such a hole. |
| `PointInTimeRecovery` | Drops everything after the first damage, whatever its cause. |

Solarium opens after every kind of power loss that its tests simulate. It refuses to open only for damage that no crash explains.

## After a failed append

After a failed WAL append, the tail of the WAL is unknown. For this reason, a WAL failure stops all later writes until the database opens again, with recovery. Reads continue in the meantime. See [Storage Failures](../operations/storage-failures.md).

## How it is tested

The [power-loss tests](../operations/testing.md#power-loss-tests) write out what a power loss can leave, in order or sector by sector in any order. They reopen the database three times in each run. This means that recovery itself is cut too.
