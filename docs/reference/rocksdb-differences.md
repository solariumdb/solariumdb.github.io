---
sidebar_position: 5
---

# Differences from RocksDB

RocksDB is the reference behavior. A deliberate difference is on this page, and an accidental difference is a bug. The RocksDB behavior that these documents describe is checked against RocksDB 11.8.1. The `Kommander.RocksDB` package that the benchmarks run (11.8.1.9002) carries a native library built from that release.

## Scope

Solarium covers the part of RocksDB that the Raft log of Kommander and the backend of Kahuna use. These features of RocksDB are not in Solarium:

- a block cache, and a shared memory budget across databases;
- subcompactions (`max_subcompactions`), and more than one flush thread (`max_background_flushes`, `max_background_jobs`);
- codecs other than LZ4;
- static level targets (`level_compaction_dynamic_level_bytes` off);
- a stall on pending compaction bytes, and `WriteOptions.no_slowdown`;
- creating or dropping a column family on an open database;
- rate limits on reads or on the WAL (`kReadsOnly`, `kAllIo`, `rate_limiter_priority`, and `wal_bytes_per_sync`);
- automatic recovery from a background error without a reopen.

## Files and formats

- **The manifest** is written again whole on each change. RocksDB appends edits to a log.
- **A data block** stores each key whole, after 17 bytes of lengths, sequence number, and kind. RocksDB stores only the part of a key that differs from the key before it, with varint lengths.
- **The WAL file** has its own header and a version, not the 32 KB blocks of RocksDB. Each WAL record carries the offset of the file that a flush made durable. Recovery uses it to tell power-loss damage from damage to flushed data. The WAL of RocksDB has no such field, so its recovery modes either fail the open after such a power loss or drop data after any damage.

## Compression and caching

- `ColumnFamilyOptions.Compression` defaults to `None`, and its only codec is `Lz4`, from the managed `K4os.Compression.LZ4`. The default of RocksDB is Snappy, and it offers more codecs.
- Only data blocks are compressed. RocksDB never compresses filter blocks, and compresses index blocks only to keep them in its block cache.
- As in RocksDB, a block that compression makes smaller by less than one eighth is stored raw.
- There is no block cache. Each SSTable block that a read needs is read from the file, and the page cache of the operating system is the only cache. So every read of a compressed block decompresses it. RocksDB decompresses a block once for each block cache miss.
- The log keys of Kommander share their first 25 of 31 bytes. With 256-byte values and no compression in either engine, the flushes of Solarium wrote 8% more bytes than the keys and values, and those of RocksDB 4% fewer.

## Levels and compaction

- **Levels are always sized dynamically**, as with the default `level_compaction_dynamic_level_bytes` of RocksDB. There is no option for static targets. A column family that got smaller keeps its base level at the first level with files, as in RocksDB, but its levels above the size that it needs are not drained. RocksDB compacts such a level down on its own.
- **The score of level 0 is its file count only.** RocksDB, with dynamic level sizing, also scores level 0 by its bytes against the target of the base level, so a few large level 0 files compact sooner. Scores do not discount the bytes that compactions are about to bring into a level, as those of RocksDB do.
- **A merge runs on one thread.** There are no subcompactions (`max_subcompactions`, whose default is 1), which split a large merge into key ranges on several threads.
- **Background threads.** Compactions run on up to `MaxBackgroundCompactions` threads, and flushes on one. There is no `max_background_jobs` to split between them, and no `max_background_flushes`. A manual compaction always runs alone, as with `exclusive_manual_compaction`, the default of RocksDB.
- **File selection.** A level 0 merge picks the oldest file first, as in RocksDB. A merge of a sorted level takes one file chosen by `kMinOverlappingRatio`, with no expansion to more files of the level, and without the checks of RocksDB on the overlap two levels down (`max_compaction_bytes`, the grandparent overlap).
- **Trivial moves.** A move from level 0 can take several files at once. RocksDB moves several level 0 files only into a level that has files, and one file into any level.
- **Range tombstone bounds.** A range tombstone is cut at the boundaries between the output files of a merge, with a user key as the excluded bound, which the table records. RocksDB bounds files with internal keys and a sentinel.
- **Sequence numbers.** A merge keeps the sequence numbers of the entries that it writes. RocksDB sets them to 0 in the bottom level.
- **`CompactRange`** does not flush a memtable that overlaps the range first.

## Write stalls

- **The delayed write rate is fixed.** RocksDB changes it while writes are delayed: it lowers the rate as the compaction backlog grows and near the stop trigger, and raises it as the backlog gets smaller.
- **There is no stall on pending compaction bytes** (`soft_pending_compaction_bytes_limit`, 64 GB). Only the level 0 file count slows and stops writes.
- **There is no `WriteOptions.no_slowdown`**, which fails a write instead of delaying it.
- **`Flush` does not wait for a stall to clear first.** The `Flush` of RocksDB (with `FlushOptions.allow_write_stall` false, the default) waits while one more level 0 file or memtable would delay or stop writes.

## Rate limiter

- **Writes only.** The `RateLimiter` paces flush and compaction writes, as the default mode of RocksDB, `kWritesOnly`. There is no `kReadsOnly` or `kAllIo`, and no `rate_limiter_priority` on reads or on `WriteOptions`.
- **The replay is not paced.** The flushes of the WAL replay inside `Open` do not go through the limiter. The recovery flushes of RocksDB do.
- **Fairness is fixed.** Every tenth refill serves the compactions first. RocksDB draws this at random, with a chance of one in ten.
- **No `wal_bytes_per_sync`.** `BytesPerSync` applies to SSTables only. The WAL syncs whole write groups.

## Option validation

`Level0FileNumCompactionTrigger` or `TargetFileSizeBase` below 1, a slowdown trigger below the compaction trigger, a stop trigger below the slowdown trigger, or a `DelayedWriteRate` below 1 throws. RocksDB raises a trigger of 0 to 1, and each later trigger to the one before it, with a warning in its log. It takes a `delayed_write_rate` of 0 as 16 MiB/s.

## Checkpoints

- `CreateCheckpoint` links the SSTables, as RocksDB does. It copies them when the file system refuses the first link, as RocksDB does after its first `NotSupported`.
- The checkpoint holds no WAL file. What the memtables hold at the sequence number of the checkpoint goes to new SSTables of the copy, and the source is not flushed. RocksDB copies its WAL files into the checkpoint while their total is below `log_size_for_flush`, and flushes the memtables of the source otherwise.
- The `FORMAT` file is written last, so a checkpoint that was cut short does not open. RocksDB builds the checkpoint in a `.tmp` directory and renames it.
- The checkpoint holds the `LOCK` of its directory while it writes, and the copy keeps the `LOCK` file.
- `Dispose` stops a running checkpoint and waits for it. With RocksDB, closing the database during a checkpoint is an error of the caller.

## Close

`Dispose` flushes the current WAL file before it closes it. So every write before a clean close survives a power loss after it. The close of RocksDB, with the WAL on, writes the WAL to the operating system without a flush (unless it uses direct I/O), and flushes no memtable. So its unsynced writes need `SyncWAL` first. A flush that fails at `Dispose` is reported after the close completes.

## Reads

- **`Prev`** searches every source for each step, so it is slower than `Next`.
- **Memtable range tombstones.** The memtable indexes its range tombstones in runs of fragments that the range delete builds, in sizes that double, and a read searches each run. RocksDB caches the fragments of all the range tombstones of a memtable, which the first read after each range delete builds again, so that read pays for all of them. In Solarium, a range delete pays, at most once each time the count of tombstones doubles, and a read searches up to one run for each doubling.

## Memory figures

- `cur-size-all-mem-tables` counts the keys and values of each memtable, 32 bytes for each entry, and the fragments of its range tombstones, so an empty memtable is 0. RocksDB counts the arena blocks that it allocated, 2 KB for an empty memtable.
- `estimate-table-readers-mem` counts the index keys and handles, the filter bits, and the range tombstones and their fragments of each open table, not its allocations.

## Group commit

- **The WAL file after `Flush`** changes at the next write group, not at once.
- **Commits are pipelined by default.** The `enable_pipelined_write` of RocksDB is off by default. In the `Put` benchmarks, pipelining makes 3 to 16 unsynced writers 5% to 15% faster, and 16 writers beside 16 readers 11% faster. It costs a single writer 1.5% to 1.7%. At 2 writers, the result changes with the build, from 8% faster to 7% slower. Because a group gives up its leadership after its WAL append, a full memtable is switched one group later than without pipelining, as in RocksDB.
- **Concurrent memtable inserts.** In a group of several writers, the leader launches the inserts of the members that still spin, and inserts the batches of the blocked members itself. RocksDB launches every member. A blocked member must wake and get a CPU before it can insert. Where most waiting writers block, as on io_uring or beside readers, a launch for every member made writes up to 2.8 times slower (5.5 times beside 16 readers) than inserts by the leader alone.
- **Publication.** The leader waits for the last insert and publishes the group. In RocksDB, the last writer to finish its insert publishes the group. The leader of Solarium holds the lock that keeps `Flush` from switching a memtable during the inserts, and that lock belongs to its thread. The `Flush` of RocksDB waits in the write queue instead.
- **Wakes.** The leader of RocksDB wakes the writers of a group of 20 or more through about √n of them. The leader of Solarium wakes each one.
- **Concurrent range deletes** go to a copy-on-write array under a small lock, not to a second skip list.
- **The offer of leadership is not a hand-off.** A writer that arrives while no leader is active takes the queue and leads it. The writer that got the offer then waits for that group. A running writer starts the next group sooner than a blocked writer can wake up.

## Writer spin

A writer that waits for its group spins for up to 20 µs before it blocks, or for 1 µs when probes show that more than about a quarter of the long spins end in a block. A writer that waits for a WAL flush does not spin.

RocksDB writers spin for about 1 µs (200 pause loops). Then, with `enable_write_thread_adaptive_yield` (on by default), they call `sched_yield` for up to `write_thread_max_yield_usec` (100 µs by default). They block after 3 yields that each take `write_thread_slow_yield_usec` (3 µs by default) or more. A credit, updated on one wait in 256, decides whether a writer yields at all.

Solarium has no yields. In the `Put` benchmarks, yields after 1 µs or 5 µs made 16 writers on 16 CPUs 8% to 10% slower than a spin without yields. Solarium keeps the sampled credit of RocksDB, with the same decay of 1/1024. But the credit chooses between a spin of 20 µs and one of 1 µs, and it stops the long spin when more than about a quarter of the probes block, not half.

Other details of the spin:

- While the spin is short, Solarium probes in windows of long spins, not one wait at a time as RocksDB does. On macOS (8 CPUs, 16 writers), single probes among short spins blocked 45% of the time, where a fixed 20 µs spin blocked 3%. So the spin stayed short, and each `Put` took about twice as long.
- The credit of RocksDB starts at 0, so one early block stops its yields. The credit of Solarium starts 16 blocks above 0. On Linux, with six writers on one thread for each core on io_uring, a credit that started at 0 made 28% to 38% of the turns spin short, where a fixed 20 µs spin blocked on 12%.
- In the benchmarks, the long spin was faster where 13% or fewer of its spins blocked, and slower where 40% or more blocked.
- With 16 readers beside 16 writers on 16 CPUs, the long spin costs the readers about 8% of their `Get` calls. Only 2% of its spins block there, so the credit keeps it.
