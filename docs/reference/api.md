---
sidebar_position: 1
---

# API Reference

The public API of Solarium follows the names and semantics of RocksDB. This page lists each public member, with its RocksDB equivalent. Where there is a difference, the table says so.

You can call the members of `SolariumDb` from any thread. Use each `Iterator` and each `WriteBatch` from one thread at a time.

## SolariumDb

The namespace is `Solarium`.

### Open and close

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `static SolariumDb Open(string path, DbOptions? options = null, IEnumerable<string>? columnFamilies = null)` | Opens the database in `path`, with all its existing column families. `columnFamilies` names the ones that must exist. | `RocksDb.Open` with `CreateIfMissing` and `CreateMissingColumnFamilies` |
| `void Dispose()` | Waits for the write and the flush in progress, stops the compaction in progress, flushes the current WAL file, closes the files, and releases the directory lock. | `Close`, but with a WAL flush (see [Differences](rocksdb-differences.md)) |

### Column families

| Member | Description |
| --- | --- |
| `ColumnFamily DefaultColumnFamily` | The column family that operations use when they pass none. It always exists. |
| `IReadOnlyCollection<ColumnFamily> ColumnFamilies` | The column families of the database, the default one included. |
| `ColumnFamily GetColumnFamily(string name)` | The column family with this name. Throws `KeyNotFoundException` when there is none. |

### Writes

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `void Put(ReadOnlySpan<byte> key, ReadOnlySpan<byte> value, ColumnFamily? family = null, WriteOptions? options = null)` | Sets the key to the value, as a batch of one operation. | `Put` |
| `void Delete(ReadOnlySpan<byte> key, ColumnFamily? family = null, WriteOptions? options = null)` | Deletes the key. | `Delete` |
| `void DeleteRange(ReadOnlySpan<byte> begin, ReadOnlySpan<byte> end, ColumnFamily? family = null, WriteOptions? options = null)` | Deletes the keys in `[begin, end)`. An empty range makes no write. | `DeleteRange`. An end before the begin throws `ArgumentException`, where RocksDB fails the write with `InvalidArgument`. |
| `void Write(WriteBatch batch, WriteOptions? options = null)` | Applies the batch atomically. It is visible to reads when `Write` returns. | `Write`, with `WriteOptions.Sync` |

### Reads

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `byte[]? Get(ReadOnlySpan<byte> key, ColumnFamily? family = null, ReadOptions? options = null)` | The newest value of the key, or null when the key is absent or deleted. The array belongs to the caller. | `Get`. Of the read options, only `fill_cache` applies. |
| `byte[]?[] MultiGet(IReadOnlyList<byte[]> keys, ColumnFamily? family = null, ReadOptions? options = null)` | Looks up several keys of one column family at one snapshot. It reads the data blocks of its keys together, through `IStorageEnvironment.MultiRead`. | `MultiGet`. Of the read options, only `fill_cache` applies. |
| `bool TryGet<TResult>(ReadOnlySpan<byte> key, ValueReader<TResult> reader, out TResult result, ColumnFamily? family = null, ReadOptions? options = null)` | Gives the newest value of the key to `reader`, in place and with no copy. True when the key has a value. Not in version 0.2.1. See [Reads in place](#reads-in-place). | `Get` into a `PinnableSlice`. Of the read options, only `fill_cache` applies. |
| `void MultiGet<TState>(IReadOnlyList<byte[]> keys, TState state, ValueVisitor<TState> visitor, ColumnFamily? family = null, ReadOptions? options = null)` | Looks up several keys of one column family at one snapshot, and gives each value to `visitor`, in place and with no copy. Not in version 0.2.1. See [Reads in place](#reads-in-place). | `MultiGet` into `PinnableSlice`s. Of the read options, only `fill_cache` applies. |
| `Iterator NewIterator(ColumnFamily? family = null, ReadOptions? options = null)` | Creates an iterator over a snapshot of the column family. The caller disposes it. | `NewIterator`, with `iterate_upper_bound` and `fill_cache` |
| `long LatestSequenceNumber` | The sequence number of the newest write that reads can see. | `GetLatestSequenceNumber` |

### Reads in place

`Get` copies the value into a new array. `TryGet`, and `MultiGet` with a visitor, give the value to a callback and do not copy it. Use them when you need a few bytes of a large value. These two members are in development. Version 0.2.1 does not have them, and they can change before a release.

```csharp
// The first 8 bytes of the value. A static lambda allocates nothing.
bool found = db.TryGet("log:0001"u8,
    static value => BinaryPrimitives.ReadInt64LittleEndian(value), out long term);

long[] terms = new long[keys.Count];
db.MultiGet(keys, terms,
    static (index, value, terms) => terms[index] = BinaryPrimitives.ReadInt64LittleEndian(value));
```

| Delegate | Description |
| --- | --- |
| `TResult ValueReader<out TResult>(ReadOnlySpan<byte> value)` | Reads the value for `TryGet`, and returns the result. |
| `void ValueVisitor<in TState>(int index, ReadOnlySpan<byte> value, TState state)` | Reads one value for `MultiGet`. `index` is the place of its key in `keys`. `state` is the state that you passed. |

- The value belongs to the engine, and is valid only until the callback returns. Copy what you need after that.
- The callback is called for a key that has a value. It is not called for a key that is absent or deleted.
- `MultiGet` calls the visitor once for each key that has a value, in no set order. A key that is in `keys` twice counts twice.
- The callback executes on the calling thread, under no lock, and it can call the database.
- A callback should be short. The memtables and the SSTables of the snapshot remain in use until the call returns, as with an open iterator.
- An exception from the callback ends the call and goes to the caller.
- Damage to a table throws `SolariumException`. `TryGet` does not call its reader in that case. `MultiGet` may have called the visitor for other keys.

RocksDB gives the caller a handle on the value. [Differences from RocksDB](rocksdb-differences.md#reads) explains why Solarium uses a callback.

### Maintenance

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `void Flush(ColumnFamily? family = null, bool wait = true)` | Makes the memtable immutable and flushes it to an SSTable. With `wait`, returns when the data is durable in an SSTable. | `Flush` with `FlushOptions.wait` |
| `void CompactRange(byte[]? begin, byte[]? end, ColumnFamily? family = null)` | Compacts the range one level after the other, down to the bottom level. Null is an open end. | `CompactRange`, without the flush of an overlapping memtable first |
| `void DeleteFilesInRange(byte[]? begin, byte[]? end, ColumnFamily? family = null, bool includeEnd = true)` | Drops the SSTables of levels 1 to 6 whose keys all lie in the range. | `DeleteFilesInRange`. `includeEnd` is true by default, as in the C API of RocksDB. |
| `void CreateCheckpoint(string directory)` | Writes a consistent copy of the database to a new directory. | `Checkpoint::CreateCheckpoint`. Its SSTables are links, or copies across file systems. It does not include a WAL file. |

### Diagnostics

| Member | Description | RocksDB equivalent |
| --- | --- | --- |
| `string? GetProperty(string name, ColumnFamily? family = null)` | The value of a RocksDB property as a decimal integer, or null for a name that is not supported. See [Properties](properties.md). | `GetProperty`, for the integer properties |
| `List<LiveFileMetaData> GetLiveFilesMetaData()` | The live SSTables of all column families. | `GetLiveFilesMetaData` |

## WriteBatch

Writes that apply all together or not at all, across any number of column families of one database. The batch copies keys and values when you add them. Use one batch from one thread at a time.

| Member | Description |
| --- | --- |
| `WriteBatch Put(ReadOnlySpan<byte> key, ReadOnlySpan<byte> value, ColumnFamily? family = null)` | Adds a put. Returns the batch. |
| `WriteBatch Delete(ReadOnlySpan<byte> key, ColumnFamily? family = null)` | Adds a delete. |
| `WriteBatch DeleteRange(ReadOnlySpan<byte> begin, ReadOnlySpan<byte> end, ColumnFamily? family = null)` | Adds a range delete. An empty range does not add an operation. An end before the begin throws `ArgumentException`, and the batch does not change. |
| `int Count` | The number of operations. |
| `long Sequence` | The sequence number of the first operation, set when `Write` returns. The operations have the numbers `Sequence` to `Sequence + Count - 1`. 0 for a batch that was never written. With a synced write, every sequence number at or below the last of the batch is durable when `Write` returns. RocksDB writes the same number into the header of a batch (`WriteBatchInternal::Sequence`). |
| `long GroupLastSequence` | The last sequence number of the write group that carried the batch, set with `Sequence`. With a synced write, every sequence number at or below it is durable when `Write` returns. This lets the writers of a group record one number between them. A later unsynced group can raise the latest sequence number of the database above it. 0 for a batch that was never written. The RocksDB equivalent is `WriteThread::WriteGroup::last_sequence`, which RocksDB does not expose. |
| `void Clear()` | Removes the operations from the batch. You can use the batch again. |

## Iterator

An ordered cursor over one column family, at the snapshot taken when it was created. Use one iterator from one thread at a time, and dispose it.

| Member | Description |
| --- | --- |
| `bool Valid()` | True when the iterator is on a key. |
| `ReadOnlySpan<byte> Key()` | The current key, valid until the iterator moves. Throws `InvalidOperationException` when the iterator is not valid. |
| `ReadOnlySpan<byte> Value()` | The current value, valid until the iterator moves. Throws `InvalidOperationException` when the iterator is not valid. |
| `void SeekToFirst()` | Moves to the first key, or becomes invalid when there is none. |
| `void Seek(ReadOnlySpan<byte> target)` | Moves to the first key at or after `target`. |
| `void SeekToLast()` | Moves to the last key, or to the last key before the upper bound. |
| `void Next()` | Moves to the next key. Throws `InvalidOperationException` when the iterator is not valid. |
| `void Prev()` | Moves to the previous key. Throws `InvalidOperationException` when the iterator is not valid. |
| `void Dispose()` | Releases the snapshot and its SSTables. Later calls have no effect. |

The seek methods throw `ObjectDisposedException` after `Dispose`.

## ColumnFamily

| Member | Description |
| --- | --- |
| `const string DefaultName` | `"default"`, the name of the column family that always exists. |
| `string Name` | The name of the column family. |

## Options records

| Type | Members |
| --- | --- |
| `WriteOptions` | `bool Sync`. Static instances: `WriteOptions.Default` (not synced) and `WriteOptions.Synced`. |
| `ReadOptions` | `byte[]? IterateUpperBound`, `bool FillCache`. Static instance: `ReadOptions.Default`. |
| `DbOptions` | The options of the database. See [Options](options.md). |
| `ColumnFamilyOptions` | The options of one column family. See [Options](options.md). |
| `CompressionType` | `None` (0) or `Lz4` (1). |
| `RateLimiter` | Paces flush and compaction writes, for `DbOptions.RateLimiter`. See [Options](options.md#ratelimiter). |
| `Cache` | An LRU cache for index and filter blocks, and for data blocks with `CacheDataBlocks`, for `ColumnFamilyOptions.BlockCache`. See [Options](options.md#cache). |
| `WriteBufferManager` | A cap on the total memtable memory of the databases that share it, for `DbOptions.WriteBufferManager`. See [Options](options.md#writebuffermanager). |

## LiveFileMetaData

`GetLiveFilesMetaData` returns one record for each live SSTable.

| Member | Description |
| --- | --- |
| `string ColumnFamilyName` | The column family of the table. |
| `int Level` | The level, from 0 to 6. |
| `string Name` | The file name with a leading slash, as RocksDB gives it: `/000012.sst`. |
| `long FileNumber` | The number in the file name. |
| `long Size` | The file size in bytes. |
| `byte[] SmallestKey` | The smallest user key in the table. |
| `byte[] LargestKey` | The largest user key in the table. It can be the exclusive end of a range tombstone. |
| `long SmallestSequenceNumber`, `long LargestSequenceNumber` | The lowest and highest sequence numbers in the table. |
| `long EntryCount` | The point entries in the table: puts and deletes. |

## Exceptions

| Exception | When |
| --- | --- |
| `SolariumException` | A failure of the engine itself: corruption, or a write after a WAL, flush, or compaction failure. `bool IsCorruption` is true for damage in a table, the WAL, or the manifest that no crash explains, as `Status::IsCorruption` of RocksDB. A retry fails again. An exception that wraps a corruption is a corruption too. See [Damage to an SSTable](../operations/durability.md#damage-to-an-sstable). |
| `ObjectDisposedException` | A call after `Dispose`. |
| `ArgumentException` | An option out of range, a range delete whose end comes before its begin, or a checkpoint directory that exists. |
| `KeyNotFoundException` | `GetColumnFamily` with a name that does not exist. |

## Storage environments

The namespace is `Solarium.Storage`.

| Type | Description |
| --- | --- |
| `IStorageEnvironment` | Where the file I/O of the engine goes. See [Storage Environments](../architecture/storage-environments.md). |
| `IStorageFile` | One open file: positional reads and writes, flush, the start of a writeback (`SyncRange`), length. |
| `ReadRequest` | One read of an `IStorageEnvironment.MultiRead` batch: a file, a buffer, an offset, and the `BytesRead` that the environment sets. |
| `DefaultStorageEnvironment` | The default storage environment, on `RandomAccess`. `DefaultStorageEnvironment.Instance` is the shared instance. |
| `Solarium.IoUring.IoUringStorageEnvironment` | The io_uring storage environment for Linux, in the `SolariumDb.IoUring` package. See [io_uring on Linux](../guides/io-uring.md). |
