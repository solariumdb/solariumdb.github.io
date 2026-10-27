---
sidebar_position: 2
---

# Solarium.Kahuna

`Solarium.Kahuna` is a [Kahuna](https://kahunakv.github.io/) storage engine on Solarium. It holds both things that a Kahuna node stores, so a node runs with no native RocksDB library:

| Kahuna option | Provider | Stores |
| --- | --- | --- |
| `--storage solarium` | `SolariumPersistenceBackendProvider` | The key-value and lock data, through `SolariumPersistenceBackend`. |
| `--wal-storage solarium` | `SolariumWalProvider` | The Raft log, through `SolariumWAL` from [Solarium.Kommander](kommander.md). |

```mermaid
flowchart LR
    K[Kahuna server] -->|"--storage solarium"| P[SolariumPersistenceBackend]
    K -->|"--wal-storage solarium"| W[SolariumWAL]
    P --> D1[(SolariumDb: kv and locks)]
    W --> D2[(SolariumDb: the Raft log)]
```

It needs Kahuna 1.14.2 or later:

- 1.13.4 brought the public storage contract: `IPersistenceBackend` with immutable rows, and the `StorageProviders` registry of `IPersistenceBackendProvider` and `IWalProvider`.
- 1.14.1 brought the storage settings that pace the compactions.
- 1.14.2 brought the memory that the WAL and the store share.

## Load it into a Kahuna server

The Kahuna server loads the package as an **extension assembly**. Publish the package, then point the server at the published assembly:

```shell
dotnet publish src/Solarium.Kahuna -c Release -o /opt/kahuna/solarium

kahuna-server --extension-assembly /opt/kahuna/solarium/Solarium.Kahuna.dll \
              --storage solarium --storage-path /var/lib/kahuna/data \
              --wal-storage solarium --wal-path /var/lib/kahuna/wal
```

The published folder holds only what the server does not have: the Solarium assemblies, ioxide (the io_uring runtime), and `K4os.Compression.LZ4` for the LZ4 of the tables. That is about 4 MB. Kahuna.Core, Kommander, and their dependencies are not in it, because the loader of the server always takes its own copy of an assembly that the server has.

Every node of a cluster loads the same artifact. The server logs the SHA-256 of each file and the engines that it registered.

## Pace the compactions

Two storage settings of Kahuna pace the compactions of the store:

| Setting | Effect |
| --- | --- |
| `--storage-compaction-rate-mbps` | Gives the store a `RateLimiter` of that rate for its flush and compaction writes, and runs `max(2, CPUs / 2)` compactions at once, as the RocksDB backend does. |
| `--storage-max-background-compactions` | Sets the number of compactions that run at once. |

With neither, the store runs one compaction at a time and paces nothing.

Choose a rate of about a third to half of what the disk commits in synced writes. On a disk that commits about 100 MB/s, a rate of 50 made the synced batches of 64 rows 2.5 times as fast as one compaction with no pacing, and loads 1.2 times as fast. See [Paced background writes](../operations/benchmarks.md#paced-background-writes). Too low a rate lets level 0 grow until writes slow down.

## Share memory between the WAL and the store

Two settings give the WAL and the store of a node memory to share. Both providers take the `SharedStorageMemory` of the node, and use the same Solarium objects for it:

| Setting | Effect |
| --- | --- |
| `--storage-shared-cache-mb` | One `Cache` for the index and filter blocks of both, pinned at level 0. It takes the place of the process-wide cache of the store (below), and the WAL, which otherwise keeps its blocks in memory, joins it. Size it to hold every index and filter of both, about 2% of their table bytes and 4% with LZ4, plus the memtable budget. |
| `--storage-shared-memtable-budget-mb` | One `WriteBufferManager` for the memtables of both, as the shared write-buffer manager of the RocksDB pair. Past it, the database that writes next flushes its own oldest memtable, never that of the other. Nothing stalls. With a shared cache, the budget is charged into the cache, so one size bounds both. |

Both are 0 by default. A Solarium WAL beside another store, or a Solarium store beside another WAL, uses them alone.

Size the memtable budget above 256 MiB, two of the 128 MiB shard memtables of the WAL. Below that, the WAL warns at open, because a smaller budget flushes the memtables of the WAL before they fill.

```mermaid
flowchart LR
    W[SolariumWAL] --> C[(Shared cache)]
    S[SolariumPersistenceBackend] --> C
    W --> B[Shared memtable budget]
    S --> B
    B -- charged into --> C
```

## Register it in an embedded node

An embedded Kahuna node registers the providers in code:

```csharp
using Solarium.Kahuna;

EmbeddedKahunaOptions options = new() { Storage = "solarium", WalStorage = "solarium", /* paths... */ };
options.StorageProviders.Register(new SolariumPersistenceBackendProvider());
options.StorageProviders.Register(new SolariumWalProvider());
```

Both providers take an `IStorageEnvironment`. The constructors with no parameters, which the extension loader calls, use the default storage environment.

## What it keeps from the RocksDB backend

`SolariumPersistenceBackend` is a port of the `RocksDbPersistenceBackend` of Kahuna. It is not a new design. It keeps:

- the database at `{storage path}/{revision}`, with the column families `kv` and `locks`;
- the rows: the `RocksDbKeyValueMessage` and `RocksDbLockMessage` protobufs of Kahuna, from `Kahuna.Core`;
- the keys: `{key}~CURRENT` for the current row, `{key}~{revision}` for each retained revision, and `{key}~NOREV` for the no-revision provenance;
- the tilde-key registry, the durability floors, and the pruned-history floor with its legacy key;
- revision pruning, with its memo, its sweep, and its quiescence proof;
- the scans, with the snapshot prefix scan and the seek over a deep revision run;
- the recovery from a storage failure: close and reopen in place, behind a swap fence;
- checkpoints: plain, exact as-of, key-filtered, and the merge of the share of one node into another.

## Differences from the RocksDB backend

- **An index and filter cache, not a block cache.** Without `--storage-shared-cache-mb`, the tables of the store keep their index and filter blocks in a 256 MiB cache that every Solarium store of the process shares, pinned at level 0. The RocksDB backend keeps them in its process-wide 256 MiB block cache. The cache holds no data blocks: the page cache of the operating system serves them. 256 MiB holds the indexes and filters of about 12 GB of tables, or 6 GB with LZ4. Past that, a lookup that misses reads one partition of the index and filter of its table again, a few kilobytes. With a cache of a quarter of them, lookups from one thread ran about 2.5 times slower. Tables written before partitions keep one whole index and filter until a compaction rewrites them, and a miss on one of them reads all of it.
- **No RocksDB tuning.** Direct reads, Bloom filter settings, statistics, and `--rocksdb-shared-memory` do not apply. The shared cache and memtable budget above do. The tables of Solarium have a fixed 10-bit Bloom filter. The `kv` column family keeps a 64 MiB memtable with up to three. The `locks` column family keeps 8 MiB with up to two. These are the sizes of the RocksDB backend.
- **Checkpoints hold no WAL.** A checkpoint is `SolariumDb.CreateCheckpoint`. Its tables are hard links to those of the store, as in RocksDB, or copies when the checkpoint is on another file system. What the memtables hold goes to tables of the copy, so the live store is not flushed. A live checkpoint is staged on the file system of the store, as in the RocksDB backend (`StagesLiveCheckpointsInStore` is true).
- **LZ4, and one compaction thread unless paced.** Both column families compress their tables with LZ4. The RocksDB backend uses Snappy, the default of RocksDB. Solarium compacts into the levels of RocksDB, sized as RocksDB sizes them. Without `--storage-compaction-rate-mbps`, it runs one compaction at a time, where the RocksDB backend runs `max(2, CPUs / 2)`. With no pacing, several compactions take the drive from synced writes, and slow them to about a third on a store of gigabytes.
- **The trim is not rate limited.** The `RateLimiter` of Solarium paces flush and compaction writes only. `BackupCaptureThrottleBytesPerSec` also counts the reads of the trim (`kAllIo` in RocksDB). So the backend does not apply it to the as-of trim of a checkpoint copy.
- **The purge flushes first.** The `CompactRange` of Solarium does not flush a memtable first. So the trim and the merge flush each column family before they compact it.
- **Batched reads read one column family for each call.** The `MultiGet` of Solarium reads one column family for each call. Every batched read here reads the `kv` column family only.

## Build against Kahuna

`Solarium.Kahuna` references the `Kahuna.Core` package from nuget.org. The loader of the server gives an extension its own copy of every assembly that the server has. So the `Kahuna.Core` of the server must have at least the assembly version that this package was built against. A server older than the referenced `Kahuna.Core` cannot load the extension.

Raise the reference only to a Kahuna release that the servers that load it already run.

## Performance

The [Kahuna benchmarks](../operations/benchmarks.md#the-persistence-backend-of-kahuna-against-rocksdb) compare both backends. In summary:

- With its tables in the page cache, Solarium matched or beat RocksDB on gets and scans. Those runs, from 2026-10-24, came before the store put its index and filter blocks in a cache.
- With LZ4, the store is the same size as that of RocksDB.
- Several compaction threads slow synced writes on a large store, because they take the drive. That is why the backend keeps one compaction thread unless you set `--storage-compaction-rate-mbps`. With 8 threads and a rate limiter of 50 MiB/s, synced batches of 64 rows ran 2.5 times as fast as with one thread, but the merges took 78 seconds after a load, against 6.
- A plain checkpoint takes about 0.1 s, because it links the tables.

## Tests

`tests/Solarium.Kahuna.Tests` holds the behavior tests of the RocksDB backend of Kahuna, ported to `SolariumPersistenceBackend`:

- the backend tests of `TestPersistenceBackends`;
- revision pruning: memo, sweep quiescence, time budget, and snapshot floor;
- as-of reads: revision at or before, probes, run seeks, prefix scans, batched gets, the monotonic current head, and no-revision writes;
- checkpoints: as-of, the pruned-history floor, key-filtered composition, and merge;
- the recovery from a storage failure.

A recovery test injects a write failure through `HookedEnvironment` on the default and io_uring storage environments. The other ported tests run on the default storage environment, as those of Kahuna do.

From end to end, a Kahuna server loaded the published extension, took writes over REST on `--storage solarium --wal-storage solarium`, and read every key back after a SIGKILL and a restart. The same run on RocksDB gave the same result.
