---
sidebar_position: 7
---

# Benchmarks

The Solarium repository has three benchmark projects. Each one runs Solarium and RocksDB, the reference behavior, on the same workload. This page explains how to run them and summarizes the results. The full results, with every case and every measurement, are in `docs/benchmarks.md` in the repository.

:::note Read the numbers with care
All results come from one machine: a 13th Gen Intel Core i7-13620H (16 CPUs), on Linux, with ext4 on a Samsung NVMe drive whose fsync takes 4 to 8 ms. Your hardware, your kernel, and your workload give other numbers. Run the benchmarks on your own hardware before you decide.
:::

## The projects

| Project | What it measures |
| --- | --- |
| `benchmarks/Solarium.Benchmarks` | The engine: `Put` from 1 to 16 threads, reads on a memtable, range tombstones, raw storage I/O, and whole compaction workloads. BenchmarkDotNet. |
| `benchmarks/Solarium.Kommander.Benchmarks` | The write path of Kommander on `RocksDbWAL` and on `SolariumWAL`, through `IWAL`. |
| `benchmarks/Solarium.Kahuna.Benchmarks` | The persistence backends of Kahuna on RocksDB and on Solarium, through `IPersistenceBackend`. |

## Run the engine benchmarks

The engine benchmarks need io_uring. In Docker:

```shell
docker build -t solarium-test .
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 --entrypoint dotnet solarium-test \
    run -c Release --no-build --project benchmarks/Solarium.Benchmarks -- --filter '*'
```

The compaction scenarios run a whole workload to its end:

```shell
dotnet run -c Release --project benchmarks/Solarium.Benchmarks -- compaction own|shared|random solarium|rocksdb [name=value ...]
```

- `own` is the Raft log of Kommander with one partition for each column family: 4 partitions append 4 million rows each, and every 100,000 rows raise their floor.
- `shared` puts 16 partitions on 8 column families, as Kommander does past 8 partitions.
- `random` writes 12 million `Put` operations of random keys from 4 million, from 4 threads.

## The Kommander WAL against RocksDB

```shell
dotnet run -c Release --project benchmarks/Solarium.Kommander.Benchmarks -- [--cases quick|full] [--only <text>] \
    [--engines rocksdb,solarium,solarium-io_uring] [--repeats 3] [--warmup 2] [--seconds 8] [--settle 2] [--dir <path>] [--csv <file>]
```

The workloads drive the WAL through `IWAL`, as `RaftManager` does. Each writer thread writes its own partition:

- `append`: one `Proposed` entry for each `Write`, as a leader appends.
- `commit`: a `Proposed` entry, then its `Committed` marker in a second `Write`.
- `batch`: 64 `Proposed` entries for each `Write`, as a follower appends a replicated batch.
- `mixed`: an append and its commit for each entry, a checkpoint and a compaction pass every 1,000 entries, and reader threads that read the last 64 entries of a random partition.

Synced cases ran on the drive. Unsynced cases ran on tmpfs (`--dir /dev/shm`), so that they measure the CPU cost and not the writeback of the disk. Entries per second, the median of three repeats, with the server GC:

| Case | RocksDB | Solarium | Solarium, io_uring | Solarium / RocksDB |
| --- | ---: | ---: | ---: | ---: |
| append, synced, 1 writer, 1 KiB | 213 | 205 | 204 | 0.96 |
| append, synced, 4 writers | 555 | 503 | 500 | 0.91 |
| append, synced, 16 writers | 1,763 | 1,781 | 1,757 | 1.01 |
| append, synced, 64 writers | 6,938 | 6,549 | 6,839 | 0.94 |
| commit, synced, 16 writers | 969 | 937 | 924 | 0.97 |
| batch of 64, synced, 1 writer | 12,600 | 14,856 | 12,584 | 1.18 |
| batch of 64, synced, 16 writers | 22,480 | 24,736 | 23,088 | 1.10 |
| mixed, synced, 16 writers | 982 | 837 | 811 | 0.85 |
| append, unsynced, 1 writer, 1 KiB | 429,534 | 464,336 | 117,302 | 1.08 |
| append, unsynced, 4 writers | 408,847 | 482,727 | 180,825 | 1.18 |
| append, unsynced, 16 writers | 304,101 | 486,631 | 279,882 | 1.60 |
| append, unsynced, 4 writers, 4 KiB | 167,539 | 236,675 | 71,890 | 1.41 |
| batch of 64, unsynced, 4 writers | 644,339 | 874,023 | 225,635 | 1.36 |
| mixed, unsynced, 4 writers | 230,070 | 226,300 | 77,345 | 0.98 |

What the results show:

- **Synced writes are bound by the drive.** Both engines group concurrent writers into one fsync, and they reach the same rates within the spread between repeats. Solarium used less CPU for each entry (26 to 55 µs against 46 to 74 µs for appends), but CPU does not limit a synced write.
- **Unsynced writes measure the CPU cost.** Solarium on the default environment wrote 1.0 to 1.6 times as many entries as RocksDB, and its median latency was lower. Its p99.9 latency was higher in the cases that write the most bytes: 2 to 6 ms against 0.01 to 0.6 ms. The cause was not measured. Garbage collection of the managed memtables and memtable switches are the likely causes.
- **io_uring is slower for unsynced writes**, at 0.3 to 0.9 times RocksDB, because each write is a hand-off to the reactor thread.
- **The synced mixed result depends on the readers.** The readers make garbage that pauses the writers. With five repeats, synced mixed writes came out at 1.00 times RocksDB. Without readers, they came out at 0.97, with 40% less CPU for each entry.

### Range tombstones

`RangeTombstoneReadBenchmarks` measures one lookup beside live range tombstones. "Scanned" is the old design, which scanned every tombstone. "Fragmented" is the current design:

| Tombstones | `Get`, memtable | `Next`, memtable | `Get`, table | `Next`, table |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0.20 µs | 12 ns | 0.65 µs | 88 ns |
| 128, scanned | 0.78 µs | 586 ns | 1.24 µs | 604 ns |
| 128, fragmented | 0.22 µs | 32 ns | 0.68 µs | 106 ns |
| 8,192, scanned | 37.0 µs | 36,683 ns | 37.2 µs | 32,952 ns |
| 8,192, fragmented | 0.23 µs | 48 ns | 0.68 µs | 119 ns |

When range deletes alternate with reads, a pair of one `DeleteRange` and one `Get` costs 4 to 9 µs at every tombstone count. If the memtable built all its fragments again at the first read after each delete, as RocksDB does, the pair cost 2,006 µs at 8,192 tombstones.

### Tail latency and garbage collection

The memtables of Solarium are on the managed heap, so the garbage collector works in proportion to what is written. Four unsynced writers of 1 KiB entries on tmpfs, 20 seconds measured:

| Ingest | GC pause, Solarium | p99.9, RocksDB / Solarium | Longest write, RocksDB / Solarium |
| --- | ---: | --- | --- |
| As fast as possible (about 480 MB/s) | 7.1 s (35%) | 18 µs / 2,064 µs | 40 ms / 16 ms |
| 25,000 entries/s for each writer (100 MB/s) | 1.6 s (8%) | 72 µs / 72 µs | 14 ms / 89 ms |
| 5,000 entries/s for each writer (20 MB/s) | 0.27 s (1.3%) | 79 µs / 82 µs | 15 ms / 12 ms |

At the rates of a busy Raft node, the tail of Solarium matches that of RocksDB. Past about 100 MB/s for each node, gen 2 collections pause the process for up to about 90 ms, where the longest write of RocksDB stays near 15 ms.

## Kahuna's persistence backend against RocksDB

```shell
dotnet run -c Release --project benchmarks/Solarium.Kahuna.Benchmarks -- --dir <path on the disk> [--cases quick|full] \
    [--datasets small,large,history] [--engines rocksdb,rocksdb-buffered,solarium,solarium-io_uring] [--repeats 3]
```

The engines:

- `rocksdb`: the defaults of Kahuna, with direct reads and a 256 MiB block cache.
- `rocksdb-buffered`: the same, with direct reads off, so that RocksDB reads its tables through the page cache, as Solarium does.
- Solarium on the default and on the io_uring environment.

The datasets: `small` has 200,000 keys of 256 bytes. `large` has 2,000,000 keys of 1 KiB, about 2 GB of values. `history` has 10,000 keys of 256 bytes written 8 times each.

Selected results, in operations per second (or seconds), with LZ4 compression and leveled compaction, the current design:

| Case | rocksdb | rocksdb-buffered | Solarium | Solarium, io_uring |
| --- | ---: | ---: | ---: | ---: |
| large, load | 9,350 | 9,927 | 9,083 | 13,129 |
| large, get, 1 thread | 8,149 | 167,607 | 253,484 | 139,818 |
| large, get, 8 threads | 66,068 | 754,977 | 953,106 | 492,566 |
| large, get-miss, 1 thread | 815,254 | 997,642 | 1,124,245 | 1,372,380 |
| large, prefix100, 1 thread | 73,948 | 446,591 | 596,825 | 328,535 |
| large, store b1024 | 7,936 | 5,504 | 7,936 | 10,624 |
| large, checkpoint-asof | 44.0 s | 40.5 s | 53.2 s | 61.7 s |

What the results show:

- **Reads need no block cache.** With its tables in the page cache, Solarium matched or beat RocksDB on gets and scans. On the default environment, it made 1.1 to 1.5 times the reads of `rocksdb-buffered`.
- **The defaults of Kahuna lose on reads that miss the block cache.** With direct reads, every block that misses the 256 MiB block cache comes from the drive.
- **The store is the size of the RocksDB store.** Kahuna writes each value twice, in two rows that sort next to each other. LZ4 stores the second copy in a few bytes, as Snappy does in RocksDB. In the run that added LZ4, before leveled compaction, the store settled at 2.4 to 2.5 GB on every engine. Without compression, the Solarium store was 4.2 GB.
- **Checkpoints link.** A plain checkpoint of `large` takes 0.10 s and writes 7 MiB, against 0.03 s for RocksDB.
- **Compaction is what is left.** One compaction at a time cannot keep level 0 and the base level as low as the 8 concurrent compactions of RocksDB during heavy writes.

## Leveled compaction

The compaction scenarios, once each:

| | Solarium | RocksDB |
| --- | ---: | ---: |
| `own`, compaction bytes written | 0 | 0 |
| `own`, files moved without a rewrite | 289 | - |
| `random`, write amplification | 4.18 | 4.62 |
| `random`, rows per second | 65,552 | 49,437 |
| `random`, most level 0 files | 33 | 17 |

**Write amplification** is the bytes that flushes and compactions wrote, divided by the bytes of the keys and values. The Raft log layout (`own`) wrote zero bytes in compactions: all 289 flushed files moved down whole. With random keys, Solarium wrote fewer bytes than RocksDB, but its level 0 grew deeper, because it runs one compaction at a time.

## Summary

| Area | Result |
| --- | --- |
| Synced writes | The same as RocksDB. The drive is the limit. |
| Unsynced writes | 1.0 to 1.6 times RocksDB on the default environment. |
| Tail latency | The same as RocksDB up to about 100 MB/s for each node. GC pauses past that. |
| Reads from the page cache | The same as or faster than RocksDB, with no block cache. |
| Store size | The same as RocksDB with LZ4. |
| Heavy random writes | Slower: one compaction at a time. |
| io_uring | Slower for unsynced writes and reads. The same for synced writes. |
