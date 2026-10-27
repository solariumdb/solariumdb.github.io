---
sidebar_position: 2
---

# Why Solarium

Solarium is a storage engine that runs inside your .NET process. It gives a service durable, ordered key-value storage with no native library to build, ship, or debug. It was built to hold the Raft log of [Kommander](https://kahunakv.github.io/kommander.github.io/), and it also runs as the storage engine of [Kahuna](https://kahunakv.github.io/). This page explains what Solarium gives you, and when it is the right choice.

## Why we built Solarium

A native storage engine is a closed box under a .NET service. You cannot change how it does I/O, tune it for one workload, or follow a slow write into it with .NET tools. Solarium moves the storage engine into C#, so that the Kommander and Kahuna projects own the whole path from `Write` to the device.

| Reason | What it gives you | Status |
| --- | --- | --- |
| **Direct control over I/O** | Every file operation goes through a [storage environment](architecture/storage-environments.md): reads, writes, flushes, renames, hard links, and directory fsync. The engine decides what is flushed, and in which order. The tests use the same interface to simulate a power loss. | Available |
| **Workload-specific optimizations** | The engine is shaped for its workloads. Appended Raft log files move down the levels with no rewrite. A range delete in the active memtable keeps dead log entries out of SSTables. The memtable indexes range tombstones in runs, so reads stay fast while a log is compacted. | Available |
| **Full integration of io_uring** | `Solarium.IoUring` sends writes through io_uring. A `MultiGet` sends the reads that the page cache misses to the ring together, so the drive serves them at once. Other reads use `pread` on the calling thread, and flushes use `fdatasync`. The engine issues one write at a time, so unsynced writes are slower than on the default storage environment. See [io_uring on Linux](guides/io-uring.md). | In progress |
| **Debugging and end-to-end profiling** | The whole path, from the write queue to the file, is C#. A .NET debugger steps into it, and a .NET profiler sees every frame, down to the lowest storage components. | Available |
| **High-level observability** | The engine reports its state in its own terms: the files and levels of each column family, memtable sizes, pending flushes and compactions, and write stalls. See [Diagnostics](operations/diagnostics.md). | Available |
| **Instrumentation as a first-class feature** | `SolariumWAL` publishes engine metrics on `System.Diagnostics.Metrics`. The engine also counts write groups, writer waits, and the time of each stage of a group commit. These detailed counters are internal for now, and only the benchmarks print them. | Partly available |
| **Tighter integration with .NET** | Keys and values are `ReadOnlySpan<byte>`. Options are records. Memtables are on the managed heap, so the .NET memory tools see them. The metrics of `SolariumWAL` work with OpenTelemetry and `dotnet-counters`. | Available |

## What you get

- **No native library.** Solarium is C#, all of it. One set of assemblies runs on every platform that .NET 10 runs on. No binary for each operating system and CPU can be missing or wrong at run time.
- **A clear durability model.** A synced write survives a power loss when `Write` returns. An unsynced write survives a process crash. Recovery tells a crash from damage that no crash can cause, and refuses to open rather than drop flushed data. See [Durability](operations/durability.md).
- **Atomic batches across column families.** One `WriteBatch` can write log entries in one column family and metadata in another. After a crash, the database holds all of the batch or none of it.
- **Fast writes from many threads.** Group commit lets concurrent writers share one WAL append and one flush. Sixteen synced writers pay for one device flush, not sixteen.
- **Reads that take no engine locks.** A read sees one consistent snapshot, and never waits for a writer to finish a batch. With a block cache, a lookup takes the lock of one cache shard.

## Built around a Raft log

The first user of Solarium is the WAL of Kommander. A Raft log has a special shape:

- Each partition appends entries with log ids that only grow.
- A commit marks entries as committed, but does not rewrite them.
- Compaction removes a dead prefix of the log, below a floor.

Solarium makes this shape cheap:

- **Appended files move down with no rewrite.** The SSTables of one partition do not overlap, so compaction moves them from level to level as they are. In the compaction benchmark, all 289 flushed files of the Raft log layout moved down with zero bytes of compaction writes.
- **A range delete costs little.** A range tombstone that covers the dead prefix stays in the active memtable. A flush drops the entries that it covers, so they never reach an SSTable.
- **Whole files go away.** `DeleteFilesInRange` drops the SSTables below the floor in one manifest save, with no rewrite.

To use Solarium as the Raft log of Kommander, pass a `SolariumWAL` to `RaftManager`. See [Solarium.Kommander](integrations/kommander.md).

## Inspired by RocksDB

The design and the API names of Solarium follow RocksDB: a write-ahead log, memtables, SSTables, column families, and leveled compaction. If you know RocksDB, you already know how Solarium works. Where Solarium behaves differently, [Differences from RocksDB](reference/rocksdb-differences.md) lists each difference.

## When to use Solarium

Solarium is a good fit when:

- you run Kommander or Kahuna and want no native dependency;
- you want an embedded, ordered key-value store inside a .NET service;
- you want to read, debug, and change the storage engine in the same language as your service.

Solarium is not the right choice when:

- you need a database server with a network protocol. Solarium is a library;
- your workload needs a cache of data blocks in the process. The block cache of Solarium holds index and filter blocks only, and the page cache of the operating system serves the data blocks;
- your workload needs fast synced writes beside heavy compactions on a large store, and you want the engine to find the pace on its own. Solarium paces compactions at a fixed rate that you choose for your drive, and its auto-tuned rate did not protect synced writes in the benchmark. See [Paced background writes](operations/benchmarks.md#paced-background-writes);
- you cannot test it yourself before production. Solarium is a young database at version 0.1.0, it is not on NuGet yet, and its on-disk format can still change.

## How fast is it?

The [Benchmarks](operations/benchmarks.md) page compares Solarium with RocksDB on the same workloads, on one machine: a 13th Gen Intel Core i7-13620H with 16 CPUs, Linux, and an NVMe drive. As the Kommander WAL:

- **Synced writes** are bound by the drive. Solarium reached 0.85 to 1.18 times the rate of the native engine.
- **Unsynced writes** measure the CPU cost. Solarium on the default storage environment wrote 1.0 to 1.6 times as many entries.
- **Tail latency** was the same at the rates of a busy Raft node. Past about 100 MB/s for each node, garbage collection pauses make the tail of Solarium longer.

As the Kahuna storage engine, reads from the page cache were as fast or faster, with no cache of data blocks. On a large store, several compaction threads slow synced writes, unless a rate limiter paces them.
