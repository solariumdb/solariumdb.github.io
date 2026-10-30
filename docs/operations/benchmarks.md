---
sidebar_position: 7
---

# Benchmarks

The Solarium repository has three benchmark projects. Each one runs Solarium and RocksDB, the reference behavior, on the same workload. This page explains how to run them and gives the current results. The full results and the method are in `docs/benchmarks.md` in the repository. Older results are in the history of that file.

:::note Read the numbers with care
Every result on this page comes from one session on 2026-10-29, unless its section gives another date. The session ran after memtables and cached data blocks moved to native memory. The machine:

- a 13th Gen Intel Core i7-13620H (16 CPUs), 31 GiB of memory, Linux 6.12;
- ext4 on a Samsung PM9B1 NVMe drive, where a synced append of 1 KiB took about 1 ms at the median;
- the server garbage collector (GC) for every benchmark, as the servers of Kahuna and Kommander use.

Your hardware, your kernel, and your workload give other numbers. Run the benchmarks on your own hardware before you decide.
:::

Before 2026-10-29, synced writes on this drive took 4 to 8 ms. So the synced rates in older results are 2 to 5 times lower than here. The ratios between the engines carry over.

The GC changes the result of a change. Under the workstation GC, the default of BenchmarkDotNet, collections took 20% to 29% of an unsynced `Put`. Under the server GC, they took 7% to 9%. A change that wins under one GC can lose under the other.

## The projects

| Project | What it measures |
| --- | --- |
| `benchmarks/Solarium.Benchmarks` | The engine, with BenchmarkDotNet: `Put` from 1 to 16 threads, reads on a memtable, range tombstones, and raw storage I/O. Also whole workloads: compaction, synced writes beside background writes, and a load on a hyperthread sibling. |
| `benchmarks/Solarium.Kommander.Benchmarks` | The Raft log of Kommander: `SolariumWAL` against `RocksDbWAL`, through `IWAL`. |
| `benchmarks/Solarium.Kahuna.Benchmarks` | The store of Kahuna: `SolariumPersistenceBackend` against `RocksDbPersistenceBackend`, through `IPersistenceBackend`. |

## Run the engine benchmarks

The engine benchmarks need io_uring, and stop when it is not available. In Docker:

```shell
docker build -t solarium-test .
docker run --rm --security-opt seccomp=unconfined --ulimit memlock=-1 --entrypoint dotnet solarium-test \
    run -c Release --no-build --project benchmarks/Solarium.Benchmarks -- --filter '*'
```

On the host, run them from the repository, with `TMPDIR` on the drive to measure. Every case writes under the temporary directory.

The `Put` cases compare Solarium on each storage environment with RocksDB through `Kommander.RocksDB`, the binding of Kommander. RocksDB runs with its defaults, and in four variants: with `enable_pipelined_write` (`pipelined`), without concurrent memtable writes (`serial`), without adaptive yields (`block`), and without both (`serial-block`). Each case runs from 1, 2, 4, and 16 writer threads, with 128-byte values.

The scenarios run a whole workload to its end:

```shell
dotnet run -c Release --project benchmarks/Solarium.Benchmarks -- compaction own|shared|random solarium|rocksdb [name=value ...]
dotnet run -c Release --project benchmarks/Solarium.Benchmarks -- synced [compactions=N] [rows=N] [seconds=N] [rate=MiB/s] [auto=true] [bytespersync=KiB] [dir=path]
```

The compaction scenarios use the shard options of Kommander, with 16 MiB memtables and no compression in either engine:

- `own` is the Raft log of Kommander with one partition for each column family. 4 partitions append 4 million rows each. Every 100,000 rows, each partition raises its floor to keep 1 million rows, and drops the files below the floor.
- `shared` puts 16 partitions on 8 column families, as Kommander does past 8 partitions.
- `random` writes 12 million `Put` operations of keys from 4 million, from 4 threads.

`compactions=N` sets the compaction threads of Solarium, 6 by default.

`synced` loads 2 million random keys with 1 KiB values. Then it writes synced batches of 1,024 rows over them, and prints the rows, the memtable switches that waited for a flush, and the stalls each second.

## Engine results

### Put

Time for each unsynced `Put`, with memtable flushes. The last column gives the fastest RocksDB variant for each thread count:

| Threads | Solarium | Solarium, io_uring | RocksDB | Fastest RocksDB variant |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 934 ns | 5,988 ns | 1,282 ns | 1,279 ns (`serial-block`) |
| 2 | 1,123 ns | 6,213 ns | 1,844 ns | 1,235 ns (`pipelined`) |
| 4 | 864 ns | 3,820 ns | 1,184 ns | 906 ns (`pipelined`) |
| 16 | 808 ns | 2,260 ns | 1,304 ns | 1,255 ns (`pipelined`) |

- **Unsynced writes are faster than those of RocksDB.** Into one memtable with no flush, Solarium took 704 to 1,032 ns, and RocksDB 1,194 to 1,931 ns.
- **Readers slow them down less.** With 4 reader threads, Solarium took 1.0 to 1.5 µs for each `Put`, against 1.6 to 3.0 µs for RocksDB with its defaults. With 16 readers on the 16 CPUs, Solarium took 2.8 to 3.3 µs. RocksDB took 4.4 to 21.8 µs with its defaults, and 4.3 to 7.0 µs with its best variant. The 16 readers made 9.1 to 9.9 million `Get` operations per second beside the writers of Solarium, and 5.4 to 5.9 million beside those of RocksDB.
- **io_uring is slow for unsynced writes.** Each write is a hand-off to the reactor thread, so it took 3 to 7 times as long as on the default storage environment. With 16 readers on every CPU, the reactor waits for a CPU: 37 to 44 µs for each `Put`.
- **Synced writes are bound by the drive.** From 1 and from 16 threads, Solarium was within 4% of RocksDB: 975 µs and 130 µs for each `Put`, against 974 µs and 125 µs. From 2 and 4 threads, it took 875 µs and 467 µs, against 636 µs and 384 µs.

Solarium allocated 560 to 580 bytes of managed memory for each synced `Put`. The RocksDB binding allocated none.

### Memtable and range tombstone reads

On a memtable of 921,600 entries:

| | Time | Allocated |
| --- | ---: | ---: |
| `Get` | 799 ns | 208 B |
| Iterator `Next` | 19.9 ns | 0 B |
| Iterator `Prev` | 296 ns | 320 B |

A memtable node and its key are one place in its native arena, so each step of a search reads one place. The iterator copies each position into buffers that it reuses, so `Next` allocates nothing.

Live keys beside range tombstones, which the memtable or the SSTable keeps in fragments:

| Tombstones | `Get`, memtable | `Next`, memtable | `Get`, SSTable | `Next`, SSTable |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 164 ns | 15 ns | 628 ns | 94 ns |
| 128 | 186 ns | 35 ns | 652 ns | 108 ns |
| 1,024 | 195 ns | 42 ns | 661 ns | 112 ns |
| 8,192 | 204 ns | 48 ns | 687 ns | 120 ns |

Before fragments, a read scanned every tombstone of each source: 37 µs for each `Get` beside 8,192 of them.

When range deletes alternate with reads, a pair of one `DeleteRange` and one `Get` or `Seek` took 3 to 12 µs at every tombstone count from 0 to 8,192. When the memtable built all its fragments again at the first read after each delete, as RocksDB does, a pair took 2 ms at 8,192 tombstones. See [Memtable](../architecture/memtable.md#range-tombstones).

### Storage files

Time for each positional read or write, on the drive:

| | 4 KB | 64 KB |
| --- | ---: | ---: |
| Read, default | 344 ns | 5.40 µs |
| Read, io_uring | 333 ns | 5.38 µs |
| Write, default | 0.93 µs | 13.8 µs |
| Write, io_uring | 6.33 µs | 21.7 µs |

Reads match, because the io_uring storage environment reads with `pread` on the calling thread. A write is a hand-off to the reactor thread. See [Storage Environments](../architecture/storage-environments.md).

### Compaction scenarios {#concurrent-compactions}

One run of each:

| | `own`, Solarium | `own`, RocksDB | `shared`, Solarium | `shared`, RocksDB | `random`, Solarium | `random`, RocksDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rows per second | 1,774,909 | 2,050,722 | 1,526,227 | 1,667,398 | 607,302 | 342,799 |
| Write amplification | 1.07 | 0.96 | 2.14 | 2.31 | 4.63 | 4.31 |
| Compaction bytes written | 0 | 0 | 4,719 MiB | 5,969 MiB | 11,084 MiB | 10,311 MiB |
| Most level 0 files | 8 | 9 | 9 | 16 | 28 | 23 |
| Writes stalled | 0 s | 0 s | 0 s | 0 s | 0.5 s | 6.0 s |
| Settled live tables against the rows kept | 1.07x | 0.98x | 1.78x | 1.25x | 1.27x | 1.23x |

Write amplification is the flush and compaction bytes over the bytes that the user wrote, without the WAL.

- **Appended keys write nothing again.** In the `own` layout of Kommander, Solarium moved all 289 flushed files down without a rewrite. RocksDB wrote no compaction byte either.
- **`random` ran 1.8 times as fast as RocksDB**, for 7% more compaction bytes. Level 0 reached the slowdown trigger in 24 of 1,056 samples.
- **`shared` settles with more dead rows.** It wrote less than RocksDB, but settled at 1.78 times the rows kept, against 1.25. The cause was not measured.

### Synced writes beside background writes

The `synced` scenario, 60 seconds of synced batches after the load:

| Compaction threads, pacing | Synced rows per second |
| --- | ---: |
| 1, none | 50,555 |
| 1, `BytesPerSync` 1 MiB | 59,830 |
| 8, none | 64,502 |
| 8, `BytesPerSync` 1 MiB | 61,411 |
| 8, limiter of 25 MiB/s | 13,424 |
| 8, limiter of 50 MiB/s | 25,160 |
| 8, limiter of 50 MiB/s, auto-tuned | 25,215 |

Without a limiter, no memtable switch waited and no write stalled. The rate moved from 16,000 to 100,000 rows per second, with the compactions that ran.

`BytesPerSync` alone changed the rate by -5% to +18%, within the spread of the compactions.

### Paced background writes

`DbOptions.RateLimiter` paces flushes as well as compactions. At 25 or 50 MiB/s, flushes fell behind the 50 to 65 MB/s that the synced batches wrote with no limiter. A memtable switch waited for a flush in every sample, and the batches slowed to 0.2 to 0.4 times the rate with no limiter.

A limiter helps only while its rate stays above what the store ingests, and below what leaves the drive free for the WAL syncs. On 2026-10-27, synced writes on this drive took 4 to 8 ms, and the batches made 11,000 to 13,000 rows per second. There, a limiter of 50 MiB/s brought 8 compaction threads back to the rate of one thread. It made the `store b64` case of Kahuna 2.5 to 3 times as fast. An auto-tuned limiter dropped to about 3 MiB/s after a quiet period, and the batches waited for level 0.

See [Pace background writes](../guides/flushes-and-compaction.md#pace-background-writes).

## The Kommander WAL against RocksDB

```shell
dotnet run -c Release --project benchmarks/Solarium.Kommander.Benchmarks -- [--cases quick|full] [--only <text>] \
    [--engines rocksdb,solarium,solarium-io_uring] [--repeats 3] [--warmup 2] [--seconds 8] [--settle 2] \
    [--rate <ops/s per writer>] [--dir <path>] [--csv <file>]
```

It measures `RocksDbWAL` from Kommander 1.11.3, and `SolariumWAL` on the default and the io_uring storage environments, each with its default tuning. Each writer thread writes its own partition, as `RaftManager` does:

- `append`: one `Proposed` entry for each `Write`, as a leader appends.
- `commit`: an entry, then its `Committed` marker.
- `batch`: 64 entries for each `Write`, as a follower appends a replicated batch.
- `mixed`: an append and its commit for each entry, a checkpoint and a compaction pass every 1,000 entries, and one reader thread for each 4 writers. A reader reads the last 64 entries of a random partition.

Synced cases ran on the drive. Unsynced cases ran on tmpfs (`--dir /dev/shm`), so that they measure the CPU cost and not the writeback of the disk. Entries per second, the median of three repeats:

| Case | RocksDB | Solarium | Solarium, io_uring | Solarium / RocksDB |
| --- | ---: | ---: | ---: | ---: |
| append, synced, 1 writer, 1 KiB | 953 | 962 | 934 | 1.01 |
| append, synced, 4 writers | 2,491 | 2,290 | 2,182 | 0.92 |
| append, synced, 16 writers | 7,468 | 7,387 | 7,337 | 0.99 |
| append, synced, 64 writers | 27,403 | 29,308 | 27,612 | 1.07 |
| commit, synced, 16 writers | 3,640 | 3,910 | 3,547 | 1.07 |
| batch of 64, synced, 1 writer | 54,991 | 56,463 | 51,271 | 1.03 |
| batch of 64, synced, 16 writers | 90,367 | 108,828 | 99,295 | 1.20 |
| mixed, synced, 16 writers | 3,419 | 3,473 | 3,135 | 1.02 |
| append, unsynced, 1 writer, 1 KiB | 453,489 | 748,007 | 162,199 | 1.65 |
| append, unsynced, 4 writers | 416,508 | 807,546 | 225,740 | 1.94 |
| append, unsynced, 16 writers | 373,158 | 892,220 | 383,954 | 2.39 |
| append, unsynced, 4 writers, 4 KiB (5 s) | 170,075 | 393,455 | 161,886 | 2.31 |
| commit, unsynced, 4 writers | 294,929 | 464,760 | 137,125 | 1.58 |
| batch of 64, unsynced, 4 writers (4 s) | 610,612 | 1,683,181 | 1,584,192 | 2.76 |
| mixed, unsynced, 4 writers | 189,440 | 286,339 | 98,292 | 1.51 |

What the results show:

- **Synced writes are bound by the drive.** Both engines group concurrent writers into one sync. They came out within 8% of each other, except batches from 16 writers at 1.2 times. Solarium used less CPU for each synced append: 25 to 54 µs, against 39 to 112 µs.
- **Unsynced writes measure the CPU cost.** Solarium on the default storage environment wrote 1.5 to 2.8 times as many entries as RocksDB, with a lower median latency.
- **The tail of unsynced writes is longer.** In the appends and commits of 1 KiB or more from 4 writers or more, the p99.9 latency of Solarium was 0.2 to 1.9 ms, against 0.02 to 0.4 ms for RocksDB. Collections paused it for 230 to 390 ms of each 10-second run. It allocated 1.6 to 9.2 KB of managed memory for each entry, where the RocksDB binding allocated 0 to 216 bytes. The memtable is native memory, so the allocations come from the write path above it. Their exact source was not profiled.
- **io_uring is slower for unsynced writes**, at 0.36 to 1.03 times RocksDB, because each write is a hand-off to the reactor thread. Batches of 64 amortize the hand-off, at 2.59 times RocksDB.
- **The readers of the mixed workload read more on Solarium.** With synced writes, they made 218,000 to 230,000 reads per second, against 126,000 on RocksDB.

### Tail latency at a fixed rate

`--rate` paces each writer. Four unsynced writers of 1 KiB entries, 20 seconds measured, one repeat:

| Ingest | p99.9, RocksDB / Solarium | Longest write, RocksDB / Solarium | GC pause, Solarium |
| --- | --- | --- | ---: |
| As fast as possible, about 410,000 and 770,000 entries/s (5 s measured) | 27 µs / 98 µs | 13 ms / 24 ms | 160 ms (3.2%) |
| 25,000 entries/s for each writer (100 MB/s) | 75 µs / 238 µs | 13 ms / 26 ms | 186 ms (0.9%) |
| 5,000 entries/s for each writer (20 MB/s) | 85 µs / 242 µs | 11 ms / 13 ms | 40 ms (0.2%) |

At these rates, the p99.9 latency of Solarium is about three times that of RocksDB, and below 0.25 ms. The GC paused Solarium for less than 1% of the time at 100 MB/s or less.

## The persistence backend of Kahuna against RocksDB

```shell
dotnet run -c Release --project benchmarks/Solarium.Kahuna.Benchmarks -- --dir <path on the disk> [--cases quick|full] \
    [--datasets small,large,history] [--engines rocksdb,rocksdb-buffered,solarium,solarium-io_uring] [--repeats 3] \
    [--warmup 2] [--seconds 8] [--threads 1,8] [--only <text>] [--csv <file>]
```

The engines:

- `rocksdb`: the defaults of Kahuna, with direct reads and a 256 MiB block cache.
- `rocksdb-buffered`: the same, with direct reads off, so that RocksDB reads its tables through the page cache, as Solarium does.
- Solarium on the default and on the io_uring storage environment.

The datasets: `small` has 200,000 keys of 256 bytes. `large` has 2,000,000 keys of 1 KiB, about 2 GB of values. `history` has 10,000 keys of 256 bytes, written 8 times each. A session loads the dataset in synced batches of 1,024 rows, reopens the store, waits for the drive to go quiet ("drain"), and runs the cases.

Operations per second (rows for writes and scans, keys for batched reads), or seconds for the cases that run once. The median of three repeats, with the tables in the page cache. `large`:

| Case | rocksdb | rocksdb-buffered | Solarium | Solarium, io_uring | Solarium / rocksdb-buffered |
| --- | ---: | ---: | ---: | ---: | ---: |
| load | 66,235 | 72,476 | 95,677 | 93,797 | 1.32 |
| drain after load | 6 s | 4 s | 12 s | 12 s | 0.33 |
| get, 1 thread | 14,129 | 212,228 | 367,200 | 366,679 | 1.73 |
| get, 8 threads | 89,248 | 881,253 | 1,600,289 | 1,559,841 | 1.82 |
| get-miss, 1 thread | 1,041,139 | 1,275,127 | 1,342,035 | 1,308,867 | 1.05 |
| get-batch16, 8 threads | 98,205 | 931,635 | 1,613,460 | 1,598,353 | 1.73 |
| prefix100, 1 thread | 98,599 | 555,101 | 849,881 | 819,671 | 1.53 |
| prefix100, 8 threads | 263,471 | 2,323,220 | 3,136,160 | 3,125,586 | 1.35 |
| store b1 | 292 | 944 | 977 | 970 | 1.03 |
| store b64 | 12,432 | 26,711 | 34,479 | 31,759 | 1.29 |
| store b1024 | 14,208 | 66,687 | 74,238 | 74,239 | 1.11 |
| mixed | 47,362 | 670,698 | 1,116,626 | 1,125,371 | 1.66 |
| checkpoint | 0.03 s | 0.04 s | 0.04 s | 0.04 s | 1.0 |
| checkpoint-asof | 12.1 s | 16.9 s | 16.7 s | 18.1 s | 1.01 |

`small` and `history`, Solarium against `rocksdb-buffered`:

| Case | `small`, rocksdb-buffered | `small`, Solarium | `history`, rocksdb-buffered | `history`, Solarium |
| --- | ---: | ---: | ---: | ---: |
| load | 215,043 | 254,664 | 219,849 | 258,421 |
| get, 1 thread | 513,416 | 564,016 | 637,572 | 1,242,530 |
| get, 8 threads | 2,285,000 | 2,537,588 | 2,513,647 | 3,609,700 |
| get-miss, 1 thread | 2,138,596 | 2,127,855 | 2,724,889 | 1,842,485 |
| get-batch16, 8 threads | 2,723,674 | 2,536,319 | 3,208,045 | 5,475,049 |
| prefix100, 8 threads | 5,674,143 | 7,637,274 | 1,969,776 | 3,687,772 |
| store b1024 | 126,205 | 160,767 | 190,204 | 224,635 |
| mixed | 1,506,173 | 2,133,669 | 3,035,821 | 3,543,188 |

What the results show:

- **Reads from the page cache beat RocksDB, with no cache of data blocks.** Solarium made 1.05 to 1.8 times the gets and scans of `rocksdb-buffered` on `large`, 1.4 to 1.95 times on `history`, and 0.93 to 1.35 times on `small`. Misses on `small` and `history` are the exception, at 0.68 to 0.99 times. Part of those small stores is probably still in memtables, which Solarium replays from its WAL at open, where RocksDB flushes them. That was not measured.
- **io_uring reads as fast as the default storage environment**, except misses from 8 threads on `large`, at 0.8 times. Its reads are `pread` calls on the calling thread.
- **The RocksDB defaults of Kahuna lose on every read that misses the block cache.** With direct reads, each such block comes from the drive.
- **Writes are faster.** Synced writes of one row are bound by the drive on every engine. Larger synced batches, and loads, ran 1.07 to 1.32 times as fast as `rocksdb-buffered`. Solarium wrote fewer bytes for each row than RocksDB.
- **The drain after the load is longer.** Every store settled at 2.4 to 2.6 GB. The compactions that the load left behind wrote 2.2 to 4.3 GB on Solarium, against 0.7 to 1.6 GB on RocksDB. RocksDB runs up to 8 compactions at once, where `Solarium.Kahuna` runs one unless you pace it.
- **Checkpoints link tables**, as those of RocksDB do. `checkpoint-asof` trims the copy and compacts it, and took as long as on `rocksdb-buffered`.

### Larger than memory

The `large` dataset again, one repeat for each engine, each in its own process under a 2 GiB memory limit (`systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0`). The limit keeps the page cache smaller than any store:

| Case | rocksdb | rocksdb-buffered | Solarium | Solarium, io_uring |
| --- | ---: | ---: | ---: | ---: |
| load | 66,671 | 42,517 | 38,513 | 28,612 |
| get, 1 thread | 15,242 | 24,348 | 30,944 | 37,564 |
| get, 8 threads | 94,465 | 148,470 | 176,033 | 208,798 |
| get-batch16, 8 threads | 105,631 | 159,149 | 180,477 | 309,438 |
| prefix100, 8 threads | 309,023 | 607,608 | 1,117,192 | 1,392,364 |
| store b1024 | 12,928 | 28,287 | 9,344 | 38,912 |
| mixed, writer rows per second | 7,320 | 13,191 | 7,176 | 11,120 |
| checkpoint-asof | 37.1 s | 30.1 s | 17.4 s | 25.7 s |

- **Gets and scans are bound by the drive.** Each engine read about 3 to 4 KB from the drive for each get. Solarium made 1.2 to 1.3 times the gets of `rocksdb-buffered`, and 1.8 times its scans.
- **io_uring helps batched reads from the drive.** Its `MultiGet` keeps the misses in flight together: 1.7 times the batched gets of the default storage environment.
- **Writes lose under the limit.** The load of Solarium ran at 0.9 times `rocksdb-buffered`, `store b1024` at 0.33 times, and its mixed writer at 0.54 times. On io_uring, `store b1024` ran at 1.4 times. Each engine ran once, so these rows vary more than the medians above.

## Data blocks in a cache

`ColumnFamilyOptions.CacheDataBlocks` keeps the data blocks that reads take in the block cache, verified and decompressed, in native memory. See [Cache data blocks](../guides/memory.md#cache-data-blocks).

The read cases of the Kahuna benchmark ran again with every column family of the store caching its data blocks in the shared 256 MiB cache of Kahuna. `small` fits in the cache. `large` is about ten times its size. Three sessions on `small` and two on `large`. Each cell is a ratio to the results without data blocks, for the default storage environment first and io_uring second:

| Case | `small` | `large` |
| --- | ---: | ---: |
| get, 1 thread | 1.33, 1.34 | 0.65, 0.68 |
| get, 8 threads | 1.16, 1.14 | 0.81, 0.85 |
| get-batch16, 1 thread | 1.35, 1.39 | 0.67, 0.69 |
| get-batch16, 8 threads | 1.40, 1.46 | 0.81, 0.82 |
| get-miss, 1 thread | 0.96, 0.96 | 0.86, 0.93 |
| get-miss, 8 threads | 0.75, 0.77 | 0.91, 1.27 |
| prefix100, 1 thread | 1.14, 1.08 | 0.71, 0.73 |
| prefix100, 8 threads | 1.05, 1.03 | 0.74, 0.77 |
| range100, 8 threads | 1.05, 1.01 | 0.78, 0.78 |
| mixed | 1.25, 1.34 | 0.87, 0.87 |

- **On a store that fits in the cache, it pays from 1 and from 8 threads.** Gets were 1.14 to 1.46 times as fast, and the mixed workload 1.25 to 1.34 times. Each hit saves a system call, a checksum, and an LZ4 decompression. Misses from 8 threads lose, at 0.75 times. That was not profiled.
- **On a store ten times the cache, it loses**, at 0.65 to 0.93 times, except misses from 8 threads on io_uring. Most reads miss. Each miss copies its block into the cache and evicts another, under the lock of a shard.
- **The GC no longer pays for it.** A get allocated about 2.4 KB of managed memory with or without the cache, and gen 2 collections stayed at 0 to 2 for each case.

So `CacheDataBlocks` is off by default. Neither `SolariumWAL` nor `Solarium.Kahuna` sets it.

## Index and filter blocks in a cache

This result comes from a scratch program on 2026-10-26, which is not in the repository. It measured `Get` on fully compacted stores of the Kahuna shapes in tmpfs, with the index and filter of each table cut into partitions of about 4 KB under a top-level index. In thousands per second:

| `Get` | Resident | Cache holds all | Cache of a quarter |
| --- | ---: | ---: | ---: |
| `small`, 1 thread | 540 | 528 | 212 |
| `small`, 16 threads | 5,127 | 4,921 | 244 |
| `large` LZ4, 1 thread | 489 | 464 | 213 |
| `large` LZ4, 16 threads | 4,394 | 4,068 | 289 |

- A cache that holds every partition read 2% to 7% slower than partitions resident in the table.
- A cache of a quarter of them read 2.5 times slower from one thread, and 11 to 20 times slower from 16 threads, where the decoded partitions of the misses were garbage.
- Opening a store adds about 1.2% to 1.7% of its table bytes to the heap, and 2.4% to 3.4% with LZ4. A table whose partitions are cached keeps only its top-level index, 0.04% of its bytes.

## Summary

| Area | Result |
| --- | --- |
| Unsynced `Put` | 934 ns from one thread, against 1,282 ns for RocksDB. Faster at every thread count, also beside readers. |
| Synced writes | Within 8% of RocksDB in most cases. The drive is the limit. |
| Kommander WAL, unsynced | 1.5 to 2.8 times the entries of RocksDB. A p99.9 latency about three times that of RocksDB, below 0.25 ms at 100 MB/s or less. |
| Reads from the page cache | 1.05 to 1.95 times the gets and scans of RocksDB on `large` and `history`. Misses on small stores are slower. |
| Larger than memory | Reads 1.2 to 1.8 times RocksDB. Writes slower on the default storage environment. |
| Compaction | 1.8 times RocksDB on random keys, with fewer stalls. Appended keys move down with no rewrite. |
| Rate limiter | Helps synced writes only while its rate stays above the ingest of the store. |
| Data blocks in a block cache | 1.14 to 1.46 times as fast on a store that fits in the cache. 0.65 to 0.93 times on a store ten times the cache. |
| io_uring | Slower for unsynced writes. The same for reads. Faster for batched reads from the drive. |
