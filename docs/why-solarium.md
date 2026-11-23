---
sidebar_position: 2
---

# Benefits and Limits

Solarium is a storage engine that your .NET process loads as a library. It gives a service durable, ordered key-value storage with no native library. It was built for the Raft log of [Kommander](https://kahunakv.github.io/kommander.github.io/), and it is also a storage engine for [Kahuna](https://kahunakv.github.io/). This page explains what Solarium gives you, and when it is the right choice.

## Design goals

A .NET service cannot change how a native storage engine does I/O. It cannot tune the engine for one workload, and .NET tools cannot follow a slow write into native code. Solarium moves the storage engine into C#. This gives the Kommander and Kahuna projects control of the full path from `Write` to the device.

| Reason | What it gives you | Status |
| --- | --- | --- |
| **Direct control over I/O** | Every file operation goes through a [storage environment](architecture/storage-environments.md): reads, writes, flushes, renames, hard links, and directory fsync. The engine decides what is flushed, and in which order. The tests use the same interface to simulate a power loss. | Available |
| **Workload-specific optimizations** | The engine is shaped for its workloads. Appended Raft log files move down the levels as they are, and compaction does not rewrite them. Dead log entries that a range delete in the active memtable covers do not reach SSTables. The memtable indexes range tombstones in runs. This lets reads stay fast while a log is compacted. | Available |
| **Full integration of io_uring** | `Solarium.IoUring` sends writes through io_uring. A `MultiGet` sends the reads that the page cache misses to the ring together, and the drive serves them at once. Other reads use `pread` on the calling thread, and flushes use `fdatasync`. The engine issues one write at a time. As a result, unsynced writes are slower than on the default storage environment. See [io_uring on Linux](guides/io-uring.md). | In progress |
| **Debugging and end-to-end profiling** | The path from the write queue to the file is entirely C#. A .NET debugger steps into it, and a .NET profiler sees its frames down to the lowest storage components. | Available |
| **High-level observability** | You can read the state of the engine in terms of the engine: the files and levels of each column family, memtable sizes, pending flushes and compactions, and write stalls. See [Diagnostics](operations/diagnostics.md). | Available |
| **Engine metrics and counters** | `SolariumWAL` publishes engine metrics on `System.Diagnostics.Metrics`. The engine also counts write groups and writer waits, and it measures the time of each stage of a group commit. These detailed counters are internal for now, and only the benchmarks print them. | Partly available |
| **Tighter integration with .NET** | Keys and values are `ReadOnlySpan<byte>`. Options are records. Memtables and cached data blocks are in native memory, as in RocksDB. They add no work for the garbage collector. The metrics of `SolariumWAL` work with OpenTelemetry and `dotnet-counters`. | Available |

## What you get

- **No native library.** Solarium is written entirely in C#. One set of assemblies works on every platform that .NET 10 supports. No binary for each operating system and CPU can be missing or wrong at run time.
- **A clear durability model.** A synced write survives a power loss when `Write` returns. An unsynced write survives a process crash. Recovery tells a crash from damage that no crash can cause. On such damage, the open fails and drops no flushed data. A block at the wrong place fails as corruption. This means that a read does not answer "not found" for a key that is in the store. See [Durability](operations/durability.md).
- **Atomic batches across column families.** One `WriteBatch` can write log entries in one column family and metadata in another. After a crash, all of the batch is in the database, or none of it.
- **Fast writes from many threads.** Group commit lets concurrent writers share one WAL append and one flush. Sixteen synced writers in one group share one device flush.
- **Reads that take no engine locks.** A read sees one consistent snapshot, and does not wait for a writer to finish a batch. With a block cache, a lookup takes the lock of one cache shard.

## Built around a Raft log

The first user of Solarium is the WAL of Kommander, which stores a Raft log. A Raft log grows at one end and loses dead entries at the other.

- Each partition appends entries with log ids that only grow.
- A commit writes a small marker. The entries stay as they were written.
- Compaction removes a dead prefix of the log, below a floor.

Compaction and range deletes in Solarium are built for this shape.

- **Appended files move down with no rewrite.** The SSTables of one partition do not overlap. Compaction moves them from level to level as they are. In the compaction benchmark, all 289 flushed files of the Raft log layout moved down with zero bytes of compaction writes.
- **A range delete costs little.** The range tombstone for the dead prefix is in the active memtable. A flush drops the entries that the tombstone covers, and those entries do not reach an SSTable.
- **Dead files go away.** `DeleteFilesInRange` drops the SSTables below the floor in one manifest save, and it does not rewrite data.

To use Solarium as the Raft log of Kommander, pass a `SolariumWAL` to `RaftManager`. See [Solarium.Kommander](integrations/kommander.md).

## Inspired by RocksDB

The design and the API names of Solarium follow RocksDB. If you know RocksDB, you know the main parts of Solarium, such as memtables, column families, and leveled compaction. Where Solarium behaves differently, [Differences from RocksDB](reference/rocksdb-differences.md) lists each difference.

## When to use Solarium

Solarium fits a .NET service that needs ordered storage in its process, and a team that wants a storage engine in C#.

- You run Kommander or Kahuna and want no native dependency.
- You want an embedded, ordered key-value store in a .NET service.
- You want to read, debug, and change the storage engine in the same language as your service.

Some deployments and workloads need a different store.

- You need a database server with a network protocol. Solarium is a library.
- Your store is much larger than memory and needs a cache of data blocks in the process. Solarium can cache data blocks (`CacheDataBlocks`), but on a store ten times the cache its LRU cache made reads slower than the page cache alone. See [Data blocks in a cache](operations/benchmarks.md#data-blocks-in-a-cache).
- Your workload needs fast synced writes beside heavy compactions on a large store, and you want the engine to find the pace for you. Solarium paces flushes and compactions at a fixed rate that you choose for your drive and your ingest. Its auto-tuned rate did not protect synced writes in the benchmark. See [Paced background writes](operations/benchmarks.md#paced-background-writes).
- You cannot test it yourself before production. Solarium is a young database at version 0.2.1, and its on-disk format can still change.

## Performance

The [Benchmarks](operations/benchmarks.md) page compares Solarium with RocksDB on the same workloads, on one machine. The machine is a 13th Gen Intel Core i7-13620H with 16 CPUs and an NVMe drive, on Linux 6.12. The first results are for the Kommander WAL.

- **Synced writes** are bound by the drive. Solarium came out within 8% of RocksDB in most cases, and at 1.2 times for batches from 16 writers.
- **Unsynced writes** measure the CPU cost. Solarium on the default storage environment wrote 1.5 to 2.8 times as many entries.
- **Tail latency** is longer. With unsynced writers at 100 MB/s or less, the p99.9 latency of Solarium was about three times that of RocksDB, and below 0.25 ms.

As the Kahuna storage engine, with the tables in the page cache, gets and scans were 1.05 to 1.95 times as fast as RocksDB on the large and history datasets, with no cache of data blocks. Loads and synced batches were 1.07 to 1.32 times as fast. Misses on small stores were slower.
