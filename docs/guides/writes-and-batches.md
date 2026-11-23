---
sidebar_position: 2
---

# Writes and Batches

A write batch groups several changes into one atomic write: all of them apply, or none of them. It is like a database transaction that only writes. A crash in the middle never leaves half of it on disk. Use it when two changes must agree, such as a log entry and the index that points to it.

Every write in Solarium is a batch. `Put`, `Delete`, and `DeleteRange` on the database are batches of one operation.

## Build a batch

```csharp
WriteBatch batch = new WriteBatch()
    .Put("user:42"u8, "Ada"u8)
    .Put("user:43"u8, "Grace"u8)
    .Delete("user:41"u8)
    .DeleteRange("session:0000"u8, "session:5000"u8);

db.Write(batch);
```

A batch is atomic and ordered, and it can write to several column families.

- It applies all its operations, or none of them.
- Its operations apply in the order that you added them.
- It can write to any number of column families of one database.
- It copies each key and value when you add it. You can change or reuse your buffers after the call.
- It is visible to reads when `Write` returns.

`batch.Count` gives the number of operations. `batch.Clear()` removes all operations. You can then use the batch again.

## Synced or unsynced

`WriteOptions` has one property, `Sync`. It is false by default.

```csharp
db.Write(batch, WriteOptions.Synced);   // Sync = true
db.Write(batch, WriteOptions.Default);  // Sync = false, the default
```

A synced write survives a power loss when `Write` returns. An unsynced write survives a process crash. However, a power loss can lose it, because the device did not get a flush. [Durability](../operations/durability.md) has the full table of what each write survives.

Use a synced write when the caller acts on the write after it returns. For example, a Raft node must not acknowledge a log entry before it is durable. Use an unsynced write when you can rebuild the data, or when a later synced write makes it durable.

The WAL is one file that only grows. This means that a synced write also makes durable every unsynced write before it.

## Many writers: group commit

You can call `Write` from any number of threads. Solarium groups the concurrent writers into one WAL append.

1. The first writer becomes the **leader** of a group.
2. The leader takes the writers that wait in the queue, up to `DbOptions.MaxWriteBatchGroupSizeBytes` of WAL records.
3. The leader writes all their records to the WAL in one append.
4. If any writer of the group asked for `Sync`, the leader flushes the WAL once for the group.
5. Each writer inserts its batch into the memtable.

This means that sixteen threads that each write a synced batch cause one device flush. A single synced writer waits for a full device flush on each write. Many synced writers share the flushes, and their total rate is higher. The [Benchmarks](../operations/benchmarks.md) page shows this: 16 synced writers made about 8 times the entries per second of 1 writer.

[Write Path](../architecture/write-path.md) explains group commit in detail.

## Know what a synced write made durable

`WriteBatch.Sequence` is the sequence number that the database gave the first operation of the batch. `Write` sets it when it returns. You can use it to record what a synced write made durable, for example in a file beside the database.

```csharp
WriteBatch batch = new WriteBatch()
    .Put("log:0001"u8, "entry"u8)
    .Put("log:0002"u8, "entry"u8);

db.Write(batch, WriteOptions.Synced);

long durable = batch.GroupLastSequence;
```

`WriteBatch.GroupLastSequence` is the last sequence number of the write group that carried the batch. The database appends a group to the WAL in one write, and flushes it once before any of its writers returns. When a synced `Write` returns, the sequence numbers at or below `durable` are all durable. The writers of one group record one number between them.

The operations of the batch itself have the numbers `batch.Sequence` to `batch.Sequence + batch.Count - 1`. Both values are 0 for a batch that was not written, and a later write of the batch sets them again. Do not record `LatestSequenceNumber` for this purpose. A later unsynced group can raise it.

## Errors

| Error | Cause |
| --- | --- |
| `ArgumentException` from `DeleteRange` | The end key comes before the begin key. The batch does not change. |
| `SolariumException` | The engine failed: a WAL, flush, or compaction failure happened before. `IsCorruption` tells [damage to the files](../operations/storage-failures.md#corruption) from a failure of the storage. |
| `ObjectDisposedException` | The database is disposed. |

After a failure of the engine, all writes throw until you open the database again. Reads continue. [Storage Failures](../operations/storage-failures.md) explains why and what to do.

## Write stalls

When flushes add level 0 files faster than compaction removes them, `Write` slows down and then stops, as in RocksDB. A write that waits in a stall returns when compaction catches up. [Write Stalls](../operations/write-stalls.md) explains the triggers.

## A large batch

A batch larger than `MaxWriteBatchGroupSizeBytes` (1 MiB by default) forms a group by itself. A very large batch occupies the memtable and the WAL for a long time, and other writers wait for it. Split a bulk load into batches of a few hundred kilobytes to a few megabytes.
