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
| `benchmarks/Solarium.Benchmarks` | The engine: `Put` from 1 to 16 threads, reads on a memtable, range tombstones, raw storage I/O, whole compaction workloads, and synced writes beside background writes. BenchmarkDotNet. |
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

The argument `compactions=N` sets the compaction threads of Solarium. By default, it is the compaction share of the background jobs that RocksDB runs there: 6 on 16 CPUs.

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
- **Unsynced writes measure the CPU cost.** Solarium on the default storage environment wrote 1.0 to 1.6 times as many entries as RocksDB, and its median latency was lower. Its p99.9 latency was higher in the cases that write the most bytes: 2 to 6 ms against 0.01 to 0.6 ms. The cause was not measured. Garbage collection of the managed memtables and memtable switches are the likely causes.
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

## The persistence backend of Kahuna against RocksDB

```shell
dotnet run -c Release --project benchmarks/Solarium.Kahuna.Benchmarks -- --dir <path on the disk> [--cases quick|full] \
    [--datasets small,large,history] [--engines rocksdb,rocksdb-buffered,solarium,solarium-io_uring] [--repeats 3]
```

The engines:

- `rocksdb`: the defaults of Kahuna, with direct reads and a 256 MiB block cache.
- `rocksdb-buffered`: the same, with direct reads off, so that RocksDB reads its tables through the page cache, as Solarium does.
- Solarium on the default and on the io_uring storage environment.

The datasets: `small` has 200,000 keys of 256 bytes. `large` has 2,000,000 keys of 1 KiB, about 2 GB of values. `history` has 10,000 keys of 256 bytes written 8 times each.

Selected results from 2026-10-24, in operations per second (or seconds), with LZ4 compression and leveled compaction. These runs came before the block cache, so every index and filter stayed in memory. The io_uring storage environment still read through the ring then. It now reads with `pread` on the calling thread, and its gets match the default environment (see [Storage Environments](../architecture/storage-environments.md#reads-on-the-calling-thread)):

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

- **Reads need no cache of data blocks.** With its tables in the page cache, Solarium matched or beat RocksDB on gets and scans. On the default storage environment, it made 1.1 to 1.5 times the reads of `rocksdb-buffered`.
- **The defaults of Kahuna lose on reads that miss the block cache.** With direct reads, every block that misses the 256 MiB block cache comes from the drive.
- **The store is the size of the RocksDB store.** Kahuna writes each value twice, in two rows that sort next to each other. LZ4 stores the second copy in a few bytes, as Snappy does in RocksDB. In the run that added LZ4, before leveled compaction, the store settled at 2.4 to 2.5 GB on every engine. Without compression, the Solarium store was 4.2 GB.
- **Checkpoints link.** A plain checkpoint of `large` takes 0.10 s and writes 7 MiB, against 0.03 s for RocksDB.
- **The rate of background writes is what is left.** Several compaction threads take the drive from synced writes. A rate limiter gives it back, but its rate depends on the drive, and RocksDB also leaves that choice to its host. See [Paced background writes](#paced-background-writes).

## Leveled compaction

The compaction scenarios, once each:

| | Solarium | RocksDB |
| --- | ---: | ---: |
| `own`, compaction bytes written | 0 | 0 |
| `own`, files moved without a rewrite | 289 | - |
| `random`, write amplification | 4.18 | 4.62 |
| `random`, rows per second | 65,552 | 49,437 |
| `random`, most level 0 files | 33 | 17 |

**Write amplification** is the bytes that flushes and compactions wrote, divided by the bytes of the keys and values. The Raft log layout (`own`) wrote zero bytes in compactions: all 289 flushed files moved down whole. With random keys and one compaction thread, Solarium wrote fewer bytes than RocksDB, but its level 0 grew deeper.

## Concurrent compactions

`MaxBackgroundCompactions` runs several compactions at once. The compaction scenarios, once each. RocksDB ran its 8 background jobs, 6 of them compactions:

| | 1 thread | 2 threads | 6 threads | RocksDB |
| --- | ---: | ---: | ---: | ---: |
| `random`, write amplification | 4.28 | 5.00 | 5.06 | 4.62 |
| `random`, rows per second | 73,422 | 53,014 | 55,294 | 49,437 |
| `random`, most level 0 files | 32 | 29 | 22 | 17 |
| `random`, time that writes stalled | 3.5 s | 0.7 s | 0 s | 131.8 s |
| `own`, rows per second | 121,049 | - | 146,489 | 121,008 |
| `own`, compaction bytes written | 0 | - | 0 | 0 |

The `large` Kahuna cases, three repeats, on the default storage environment. Eight threads is `max(2, CPUs / 2)`, the setting of the RocksDB backend:

| Case | 1 thread | 2 threads | 8 threads |
| --- | ---: | ---: | ---: |
| load | 9,083 | 8,555 | 8,753 |
| get, 8 threads | 953,106 | 1,024,599 | 1,136,924 |
| store b64 | 3,080 | 2,840 | 2,528 |
| store b1024 | 7,936 | 2,432 | 2,816 |
| checkpoint-asof | 53.2 s | 45.2 s | 47.5 s |

What the results show:

- **Level 0 stays lower, and writes stop stalling.** With 6 threads, level 0 in the `random` scenario peaked at 22 files against 32, under the slowdown trigger, and no write waited. The Raft log layout (`own`), whose compactions are moves, ran 1.2 times as fast, still with no compaction byte written.
- **More threads write more bytes.** With one thread, the score of level 0 always wins, so the merges of the sorted levels wait, and each merge of level 0 takes many files at once. With more threads, the sorted levels compact as soon as they pass their targets. The `random` scenario wrote 5.0 times its bytes against 4.28, close to the 4.62 of RocksDB, and still wrote more rows per second than RocksDB.
- **Synced writes slow down.** In the `large` cases, synced batches of 1,024 rows came out at 0.31 to 0.35 times the rate of one thread. Two threads did the same as eight. RocksDB kept 7,936 rows per second there. The next section measures the cause.

`SolariumWAL` uses 6 threads on 16 CPUs by default, because the Raft log layout gains from them. `Solarium.Kahuna` keeps one, for its synced writes.

## Synced writes beside background writes

```shell
dotnet run -c Release --project benchmarks/Solarium.Benchmarks -- synced [compactions=N] [rows=N] [seconds=N] [rate=MiB/s] [auto=true] [bytespersync=KB] [dir=path]
```

The `synced` scenario loads random keys with 1 KiB values. Then it writes synced batches of 1,024 rows over them. Each second, it prints the rows written, the memtable switches that waited for a flush, the write stalls, and the time in the WAL append and its sync.

With 2 million rows, one compaction thread and then eight, no memtable switch waited and no write stalled. The time went to the WAL append:

| Background work | Synced rows per second |
| --- | ---: |
| None | about 29,000 |
| One flush | about 8,000 |
| One compaction | 4,000 to 10,000 |
| Three or four compactions | 700 to 3,000 |

The drive of these results commits synced writes at about 100 MB/s. A 2.5 MB append and its sync took 24 ms at the median. Beside other threads that write 64 MB files and sync each one at its end:

| Other writer threads | Median sync | 99th percentile |
| --- | ---: | ---: |
| One | 154 ms | 839 ms |
| Four | 1,200 ms | 1,708 ms |
| Four, with `sync_file_range` every 1 MB | 573 ms | 970 ms |

So on this drive, synced writes are bound by its bandwidth, and every byte that flushes and compactions write comes out of their share. More compaction threads add little work, but they do it at the same time, just after the flushes, when synced writes need the drive. The scores of RocksDB for dynamic level sizing, tried in Solarium, changed nothing here.

## Paced background writes

`DbOptions.RateLimiter` paces flush and compaction writes, and `DbOptions.BytesPerSync` starts the writeback of each table while it is written. See [Pace background writes](../guides/flushes-and-compaction.md#pace-background-writes).

The synced batches of the `synced` scenario, for 60 seconds after a load of 2 million rows. The argument `rate` sets the limiter in MiB/s after the load, so the load itself is not paced. `auto=true` makes it auto-tuned, and `bytespersync` sets `BytesPerSync` in KB:

| Compaction threads, pacing | Synced rows per second |
| --- | ---: |
| 1, none | 13,153 |
| 1, `BytesPerSync` 1 MiB | 13,286 |
| 8, none | 10,927 |
| 8, `BytesPerSync` 1 MiB | 11,501 |
| 8, limiter of 25 MiB/s | 13,341 |
| 8, limiter of 50 MiB/s | 13,210 |
| 8, limiter of 50 MiB/s, auto-tuned | 3,941 |

The `large` Kahuna cases, three repeats, with `Solarium.Kahuna` set to 8 compaction threads and a limiter of 50 MiB/s. The other columns are one thread and eight threads with no limiter, and the RocksDB engines:

| Case | 1 thread | 8 threads | 8 threads, 50 MiB/s | rocksdb | rocksdb-buffered |
| --- | ---: | ---: | ---: | ---: | ---: |
| load | 9,083 | 8,753 | 10,800 | 9,350 | 9,927 |
| load, bytes written for each row | 9,446 | 10,261 | 6,658 | 7,952 | 8,026 |
| drain after the load | 6 s | 6 s | 78 s | 18 s | 16 s |
| get, 8 threads | 953,106 | 1,136,924 | 1,131,218 | 66,068 | 754,977 |
| get-miss, 1 thread | 1,124,245 | 1,157,447 | 1,478,010 | 815,254 | 997,642 |
| store b64 | 3,080 | 2,528 | 7,576 | 3,824 | 7,584 |
| store b1024 | 7,936 | 2,816 | 8,064 | 7,936 | 5,504 |
| mixed | 996,438 | 926,805 | 944,142 | 5,390 | 639,426 |
| checkpoint-asof | 53.2 s | 47.5 s | 45.5 s | 44.0 s | 40.5 s |

What the results show:

- **A fixed rate gives synced writes their drive back.** With 8 threads and a limiter of 25 or 50 MiB/s, the synced batches came back to the rate of one thread. In the `large` cases, `store b64` ran 2.5 to 3 times as fast as one thread or eight with no limiter, as fast as `rocksdb-buffered`. `store b1024` matched RocksDB. The load ran 1.2 times as fast as one thread, and wrote 0.7 times the bytes for each row while it ran.
- **The work moves to the drain.** At 50 MiB/s, the merges that the load left behind took 70 to 82 seconds after it. One thread took 6 seconds, and RocksDB, which paces nothing by default, took 18.
- **`BytesPerSync` alone helps a little:** 5% with 8 threads.
- **Auto-tuning collapsed here.** When no write waits, an auto-tuned limiter drops to a twentieth of its rate, as in RocksDB. It climbs back by 5% every 10 seconds at the default period. After the drain, the rate fell to about 3 MiB/s, level 0 grew past the slowdown trigger, and the synced batches waited for the stall. An auto-tuned limiter suits a high rate that only smooths bursts. In these runs, it did not protect synced writes. These runs came before a fix to how an auto-tuned limiter counts the time that writes waited. Before the fix, steady demand could read as half idle, so the rate stayed low. The auto-tuned case was not measured again after the fix.
- **The rate depends on the drive.** 25 to 50 MiB/s is about a third to a half of what this drive commits in synced writes. A faster drive needs a higher rate. Too low a rate lets level 0 grow until writes stall.

## Index and filter blocks in a cache

A scratch program measured `Get` on fully compacted stores of two Kahuna shapes, with and without LZ4:

- `small`: 1,000,000 rows, 24-byte keys, 256-byte values;
- `large`: 500,000 rows, 1 KB values.

The stores were on tmpfs, so every read came from memory, as from the page cache. Each case ran 5 seconds of `Get` on random written keys, from 1 and from 16 threads, on an i7-13620H (16 threads), on 2026-10-26.

### Before partitions

First, the index became one array of keys instead of one array for each key. The heap that opening the store adds, as a share of the table bytes:

| Shape | Before | After |
| --- | --- | --- |
| Kommander, 31-byte keys, 256-byte values | 2.34%, 4.70% with LZ4 | 1.69%, 3.40% |
| Kahuna `small` | 2.22%, 4.29% | 1.55%, 3.01% |
| Kahuna `large` | 1.88%, 3.64% | 1.23%, 2.38% |

`Get`, in thousands per second. "Resident" keeps the index and filter in the table. The cache columns hold every index and filter, pinned at level 0, or a quarter of them:

| Shape | Threads | Resident, before | Resident | Cache holds all | Cache of a quarter |
| --- | --- | ---: | ---: | ---: | ---: |
| `small` | 1 | 521 | 543 | 543 | 1.4 |
| `small` | 16 | 5,200 | 5,368 | 4,983 | 5.8 |
| `small` LZ4 | 1 | 464 | 463 | 471 | 0.6 |
| `small` LZ4 | 16 | 4,759 | 4,788 | 4,310 | 2.7 |
| `large` | 1 | 504 | 505 | 500 | 1.8 |
| `large` | 16 | 2,820 | 2,757 | 3,634 | 3.2 |
| `large` LZ4 | 1 | 469 | 466 | 472 | 0.9 |
| `large` LZ4 | 16 | 4,189 | 4,304 | 4,045 | 3.3 |

- The compact index changed no read. The two resident columns are within the noise of each other.
- A cache that holds everything cost nothing from one thread, and 6% to 10% from 16 threads on three of the shapes, where each lookup takes the lock of a shard. The `large` case without compression ran low from 16 threads in both builds, so its gain is noise.
- A cache smaller than the indexes and filters thrashed. A lookup on a table whose entry was not cached read and decoded the whole index and filter of the table, about 1 MB for a 64 MB table. The entry was larger than a shard, so it was evicted as it went in. Lookups ran 300 to 700 times slower, with hundreds of gen 2 collections.
- A scan was the same in every case, because an iterator keeps the index of each table.

### With partitions

The same runs after the index and filter became partitions of about 4 KB under a top-level index (table version 4), with the stores written again:

| Shape | Threads | Resident | Cache holds all | Cache of a quarter |
| --- | --- | ---: | ---: | ---: |
| `small` | 1 | 540 | 528 | 212 |
| `small` | 16 | 5,127 | 4,921 | 244 |
| `small` LZ4 | 1 | 473 | 460 | 208 |
| `small` LZ4 | 16 | 4,830 | 4,478 | 263 |
| `large` | 1 | 541 | 503 | 218 |
| `large` | 16 | 3,185 | 3,404 | 313 |
| `large` LZ4 | 1 | 489 | 464 | 213 |
| `large` LZ4 | 16 | 4,394 | 4,068 | 289 |

- **A miss now reads one partition**, a few kilobytes. A cache of a quarter of the partitions made lookups from one thread about 2.5 times slower than a cache that holds them all, where it made them hundreds of times slower before.
- **From 16 threads, a small cache still costs a lot**: 11 to 20 times slower. The misses allocate their decoded partitions, about 2 seconds of the 5 were garbage collection pauses, and a cache of 1 MB has only two shards.
- **A cache that holds every partition** read 2% to 5% slower than resident partitions from one thread, and up to 7% from 16, within the noise of the `large` case.
- **Memory.** The heap that opening adds is the same as before partitions, within the noise (4.43 MB for `small` against 4.19 MB). A table whose partitions are cached keeps 0.04% of its bytes: the top-level index.

## Summary

| Area | Result |
| --- | --- |
| Synced writes | The same as RocksDB. The drive is the limit. |
| Unsynced writes | 1.0 to 1.6 times RocksDB on the default storage environment. |
| Tail latency | The same as RocksDB up to about 100 MB/s for each node. GC pauses past that. |
| Reads from the page cache | The same as or faster than RocksDB, with the index and filter in memory. |
| Index and filter in a block cache | 2% to 7% slower than in memory, when the cache holds them all. About 2.5 times slower from one thread with a quarter of them. |
| Store size | The same as RocksDB with LZ4. |
| Heavy random writes | More rows per second than RocksDB. With one compaction thread, level 0 grows deeper; with 6, writes do not stall. |
| Synced writes on a large store | Slower with more than one compaction thread and no limiter. With 8 threads and a limiter of 50 MiB/s, as fast as one thread or faster, but the merges take longer after a load. |
| io_uring | Slower for unsynced writes. The same for synced writes and for reads. 2.5 times the default environment for `MultiGet` from the drive, from one thread. |
