---
sidebar_position: 2
---

# Writes and Batches

A write batch groups several changes into one write that lands whole, or not at all. It is like a database transaction that only writes: a crash in the middle never leaves half of it on disk. Use it whenever two changes must agree, such as a log entry and the index that points to it.

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

The rules of a batch:

- It applies all its operations, or none of them.
- Its operations apply in the order that you added them.
- It can write to any number of column families of one database.
- It copies each key and value when you add it. You can change or reuse your buffers after the call.
- It is visible to reads when `Write` returns.

`batch.Count` gives the number of operations. `batch.Clear()` removes all operations, so you can use the batch again.

## Synced or unsynced

`WriteOptions` has one property, `Sync`:

```csharp
db.Write(batch, WriteOptions.Synced);   // Sync = true
db.Write(batch, WriteOptions.Default);  // Sync = false, the default
```

A synced write survives a power loss when `Write` returns. An unsynced write survives a process crash, but a power loss can lose it, because the device did not get a flush. [Durability](../operations/durability.md) has the full table of what each write survives.

Use a synced write when the caller acts on the write after it returns. For example, a Raft node must not acknowledge a log entry before it is durable. Use an unsynced write when you can rebuild the data, or when a later synced write makes it durable.

A synced write also makes durable every unsynced write before it, because the WAL is one file that only grows.

## Many writers: group commit

You can call `Write` from any number of threads. Solarium groups the concurrent writers:

1. The first writer becomes the **leader** of a group.
2. The leader takes the writers that wait in the queue, up to `DbOptions.MaxWriteBatchGroupSizeBytes` of WAL records.
3. The leader writes all their records to the WAL in one append.
4. If any writer of the group asked for `Sync`, the leader flushes the WAL once for the group.
5. Each writer inserts its own batch into the memtable.

So sixteen threads that each write a synced batch cause one device flush, not sixteen. A synced write is slow alone, but many synced writers together are fast. The [Benchmarks](../operations/benchmarks.md) page shows this: 16 synced writers made about 8 times the entries per second of 1 writer.

[Write Path](../architecture/write-path.md) explains group commit in detail.

## Errors

| Error | Cause |
| --- | --- |
| `ArgumentException` from `DeleteRange` | The end key comes before the begin key. The batch does not change. |
| `SolariumException` | The engine failed: a WAL, flush, or compaction failure happened before. |
| `ObjectDisposedException` | The database is disposed. |

After a WAL, flush, or compaction failure, the database refuses all writes until you open it again. Reads continue. [Storage Failures](../operations/storage-failures.md) explains why and what to do.

## Write stalls

When flushes add level 0 files faster than compaction removes them, `Write` slows down and then stops, as in RocksDB. A write that waits in a stall returns when compaction catches up. [Write Stalls](../operations/write-stalls.md) explains the triggers.

## A large batch

A batch larger than `MaxWriteBatchGroupSizeBytes` (1 MiB by default) is a group of its own. This is correct and safe. But a very large batch holds the memtable and the WAL for a long time, and other writers wait for it. Split a bulk load into batches of a few hundred kilobytes to a few megabytes.
