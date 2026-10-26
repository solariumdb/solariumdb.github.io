---
sidebar_position: 1
---

# Solarium.Kommander

`Solarium.Kommander` is a [Kommander](https://kahunakv.github.io/kommander.github.io/) write-ahead log on Solarium. `SolariumWAL` implements the `IWAL` interface of Kommander. A host passes it to `RaftManager` in place of `RocksDbWAL`, with no change to Kommander and no native library to ship.

It targets Kommander 1.11.3 and .NET 10. This is version 0.1.0, so the on-disk format can still change.

## Use it

Add a project reference to `src/Solarium.Kommander/Solarium.Kommander.csproj` (see [Getting Started](../getting-started.md#add-solarium-to-your-project)). Then create the WAL and pass it to `RaftManager`:

```csharp
using Kommander;
using Kommander.Discovery;
using Kommander.Time;
using Solarium.Kommander;

using SolariumWAL wal = new("/var/lib/node1/raft", "v1", logger, syncWrites: true);

RaftManager raft = new(configuration, new StaticDiscovery(peers), wal, communication, new HybridLogicalClock(), logger);
```

The constructor parameters:

| Parameter | Meaning |
| --- | --- |
| `path` | The base directory. The WAL lives in `{path}/{revision}`, which is created when it does not exist. One process opens it at a time. |
| `revision` | The name of the subdirectory, for example `"v1"`. |
| `logger` | An `ILogger<IRaft>`. |
| `syncWrites` | True by default. See [Durability](#durability). |
| `options` | A `SolariumWalOptions`, or null for the defaults. See [Options](#options). |

`RaftManager` disposes its WAL when it is disposed.

### io_uring

On Linux, the `Solarium.IoUring` package writes the files through io_uring. Pass the environment through the options. The host owns the environment, and disposes it after the WAL:

```csharp
using Solarium.IoUring;
using Solarium.Kommander;

using IoUringStorageEnvironment environment = new();
using SolariumWAL wal = new(path, "v1", logger, syncWrites: true, new SolariumWalOptions { Environment = environment });
```

io_uring matches the default environment on synced writes, because their fsync does not go through the ring. It is slower on unsynced writes, because each write is a hand-off to the reactor thread. See [io_uring on Linux](../guides/io-uring.md).

## Durability

- `syncWrites: true`, the default: a write is flushed to the disk before `Write` returns, so it survives a power loss.
- `syncWrites: false`: a write reaches the operating system before `Write` returns, so it survives a process crash but not a power loss. This is the same as in `RocksDbWAL`.
- Hard state (the term and the vote) goes through `SetMetaData`, which is not synced, as in `RocksDbWAL`. The `IWAL` interface of Kommander documents that choice.

## What it keeps from RocksDbWAL

`SolariumWAL` is a port of the `RocksDbWAL` of Kommander (commit `1bee500`, the release 1.11.3). It is not a new design. It keeps:

- the column families `default`, `metadata`, and `shard0` to `shard7`. Partition `p` goes in `shard{p % 8}`;
- one row for each log entry, under the key `{partition:D10}:{id:D20}`. The row holds the `RaftLogMessage` protobuf encoding, written and read by hand as `RocksDbWAL` does;
- the metadata keys of each partition: the last checkpoint, the commit frontier, and the compaction floor, and the hard state and HLC floor that Kommander writes through `SetMetaData`;
- the format version `2.0.0` in the `version` metadata key, checked at open;
- the commit frontier, the compaction floor, and the snapshot boundary.

Some terms in this list:

- The **commit frontier** is the highest committed log id of a partition. A commit marker is a small metadata put, not a rewrite of the row.
- The **compaction floor** is the log id below which the log is dead. The dead prefix is removed by the floor, a range delete in the active memtable, and whole-file drops with `DeleteFilesInRange`. See [Range Deletes](../guides/range-deletes.md#the-raft-log-pattern).

The rows and keys are the same bytes, but the files are those of Solarium. A `RocksDbWAL` directory does not open as a `SolariumWAL` directory, and the reverse is also true. To move a node from one to the other, copy the rows. This package does not do that for you.

## Options

`SolariumWalOptions` sets the shard tuning, as `RocksDbWalTuning` does for RocksDB:

| Option | Default | Meaning |
| --- | --- | --- |
| `ShardWriteBufferSizeBytes` | 128 MiB | The memtable size of each shard: the flush unit. The RocksDB tuning merges two 64 MB memtables for each flush. Solarium does not merge memtables, so one 128 MiB memtable is the same unit. A larger unit writes less, because rows that a compaction pass deletes while they are in the memtable never reach an SSTable. |
| `ShardMaxWriteBufferNumber` | 3 | The memtables that a shard holds before writes wait for a flush. At least 2. |
| `ShardLevel0FileNumCompactionTrigger` | 8 | The level 0 files of a shard that start a compaction. |
| `ShardLevel0SlowdownWritesTrigger` | 28 | The level 0 files of a shard that slow writes. |
| `ShardLevel0StopWritesTrigger` | 44 | The level 0 files of a shard that stop writes. |
| `MaxTotalWalSizeFlushUnits` | 2 | The WAL size cap, in flush units. Past it, the column families that keep the oldest WAL file are flushed, so a shard with few writes does not keep every WAL file. 0 keeps the default of Solarium. |
| `Environment` | the default environment | Where the files go. |
| `TickSource` | the system clock | The clock of the failure log cadence and of the probe interval. |

A partition that owns its shard writes files that do not overlap. So they move down the levels with no rewrite.

## Concurrency

Every member is safe to call from any thread.

- **Appends** hold the shared side of a write guard. So they overlap, and the group commit of Solarium joins their WAL flushes.
- **Scan-then-delete operations** (the truncations and the snapshot boundary), and appends that carry a checkpoint, hold the exclusive side. So an append cannot land between their scan and their batch.
- **Commits** also hold a lock for each partition that they commit, in partition order, from the read of the commit frontier to the write of the new one. A partition delete holds it for its write. So an advance computed from an old frontier cannot land after a newer one.

Appends to other partitions, and appends without commit markers, do not wait for the partition lock.

## After a storage failure

A failed write stops every later write of a Solarium database until it opens again. After a failure, `SolariumWAL` asks two questions:

1. Does the volume take a small durable write? It writes a probe file through the storage environment.
2. Does the database take a write? It writes a canary put.

Only when the volume takes the write and the database does not, does `SolariumWAL` close the database and open it again. Then it retries the operation once.

- While the volume still refuses writes, for example because the disk is full, every write reports `Errored` and nothing reopens. Kommander retries on its own cadence.
- A reopen that fails leaves the WAL closed. The next failed write tries again.
- Nothing acknowledged is lost. Synced writes were flushed, and unsynced writes reached the operating system.

## Metrics

Kommander publishes its `raft.wal.*` instruments on its meter, `"Kommander"`. Most of them come from Kommander itself, whatever the WAL: batches, operations, batch size, queue depth, the oldest pending write, write duration, and compaction passes.

Kommander connects the instruments that read the storage engine to `RocksDbWAL` only. So `SolariumWAL` publishes them on its own meter, `SolariumWalMetrics.MeterName` (`"Solarium.Kommander"`), with the same names, units, and meanings. A host listens to both meters:

```csharp
builder.Services.AddOpenTelemetry().WithMetrics(metrics => metrics
    .AddMeter("Kommander")
    .AddMeter(SolariumWalMetrics.MeterName));
```

| Instrument | Kind | Value |
| --- | --- | --- |
| `raft.wal.delayed_write_rate` | gauge, By/s | The rate that writes slow down to, or 0 (`rocksdb.actual-delayed-write-rate`). |
| `raft.wal.write_stalled` | gauge | 1 while writes are stopped, else 0 (`rocksdb.is-write-stopped`). |
| `raft.wal.shard_live_sst_bytes` | gauge, By | The live SSTable bytes of the shard column families. |
| `raft.wal.shard_l0_files`, `raft.wal.shard_l6_files` | gauge | The SSTables of the shard column families in level 0 and in level 6, the bottom level. |
| `raft.wal.table_readers_memory` | gauge, By | The bytes that the open SSTables keep in memory: index, filter, and range tombstones. |
| `raft.wal.memtable_memory` | gauge, By | The bytes of the memtables of every column family, flushing ones included. |
| `raft.wal.alive_log_bytes` | gauge, By | The bytes of the WAL files in the database directory, which a restart replays. |
| `raft.wal.engine_reopens_total` | counter | Reopens of the database to clear a storage failure, tagged `outcome`: `success` or `failed`. |

Each open `SolariumWAL` reports one measurement for each gauge, without tags, as each `RocksDbWAL` does. It stops at `Dispose`. Solarium has no block cache, so `raft.wal.block_cache_usage` and `raft.wal.block_cache_pinned_usage` have no counterpart. The instruments cost nothing while no listener is attached.

## Differences from RocksDbWAL

- **No shared resources.** `RocksDbSharedResources` (a block cache and a write-buffer manager that several databases share) has no equivalent yet.
- **The engine gauges are on a second meter.** A host adds the `"Solarium.Kommander"` meter. There are no block cache gauges.
- **A write after `Dispose` throws** `ObjectDisposedException`, as a read does. `RocksDbWAL` reports it as a storage failure first and probes the volume of the closed WAL.
- **A new WAL is one whose database holds nothing.** `RocksDbWAL` takes a WAL as new when its directory does not exist, and refuses an existing directory without a `version` key. So a directory that a host created first never opens, and neither does one that a crash left during the first open. `SolariumWAL` writes the version synced, before any row, and refuses only a database that holds data without a version.
- **The header reader skips length-delimited fields correctly.** In `RocksDbWAL`, `ReadHeaderFromWire` and `ReadTermFromWire` skip a length-delimited field one byte short. Then a `Proposed` row with the log type `op` and a 32-byte payload reads with the first byte of the payload as its type, and the proposed-tail sweep can keep an uncommitted entry. `SolariumWAL` reads the length first, and refuses a length past the end of the row.
- **The commit frontier never moves back under concurrent commits.** In `RocksDbWAL`, two commits of one partition that overlap can land in the opposite order. After a reopen, the commits that the higher advance absorbed read `Proposed`. `SolariumWAL` serializes the advances of each partition (see [Concurrency](#concurrency)).
- **The WAL file after a flush.** Solarium starts a new WAL file at the first write after a flush, not at the flush. So a closed WAL keeps its last file until then.

## Tests

`tests/Solarium.Kommander.Tests` holds:

- the conformance suite of Kommander for `IWAL` backends, copied with no change from the same commit;
- the behavior tests of the `RocksDbWAL` suites of Kommander, ported to `SolariumWAL`: reads and writes, checkpoints, the commit frontier, the compaction floor and its file layout, truncation and the snapshot boundary, the torn WAL tail, and the recovery after a write failure;
- `WalCrashTests`, which crashes a `SolariumWAL` at random storage operations of a random Kommander workload, and compares it with a second `SolariumWAL` that never crashes;
- `ClusterTests`, which runs Kommander clusters of three nodes in one process, each node on its own `SolariumWAL`;
- `MetricsTests`, which reads the instruments through a `MeterListener`.

Each test runs on the default and the io_uring environment. [Testing](../operations/testing.md) describes the crash tests, and [Benchmarks](../operations/benchmarks.md#the-kommander-wal-against-rocksdb) compares the write path with `RocksDbWAL`.
