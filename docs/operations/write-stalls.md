---
sidebar_position: 3
---

# Write Stalls

When flushes add [level 0](../guides/flushes-and-compaction.md#compaction) files faster than compaction removes them, writes slow down and then stop, as in RocksDB. A **write stall** protects reads: without it, level 0 would grow without limit, and each read would search more files.

## The triggers

| Level 0 files of a column family | What happens |
| --- | --- |
| `Level0FileNumCompactionTrigger` (4) | A compaction of level 0 starts. |
| `Level0SlowdownWritesTrigger` (20) | Writes slow down to `DelayedWriteRate`. |
| `Level0StopWritesTrigger` (36) | Writes stop until compaction brings every column family below the trigger. |
| `MaxWriteBufferNumber` memtables (2) | A memtable switch waits for a flush. |

The condition is for the whole database. One column family past a trigger holds back the writes to every column family. Files that a compaction reads count.

## Delay

While a column family has `Level0SlowdownWritesTrigger` level 0 files:

1. Each WAL leader, before it appends its group, takes credit from a bucket.
2. The bucket refills at `DelayedWriteRate` once each millisecond.
3. The leader pays for the bytes of the group before it.
4. With too little credit, the leader sleeps in steps of 1 ms until the rate pays for those bytes or the delay ends.

The writers behind the leader wait in the queue.

## Stop

While a column family has `Level0StopWritesTrigger` level 0 files, the leader waits until a flush or a compaction brings every column family below the trigger. A flush or compaction failure, or `Dispose`, fails the waiting group.

Flushes still run during a stop. So level 0 can grow past the stop trigger.

## Turn off the level 0 stalls

A column family with `DisableAutoCompactions` stalls nothing, as in RocksDB, because no compaction would end its stall. The memtable count still stalls writes.

## Watch for stalls

| Signal | Meaning |
| --- | --- |
| `rocksdb.actual-delayed-write-rate` | The rate in bytes per second while writes are delayed, else 0. |
| `rocksdb.is-write-stopped` | 1 while writes are stopped. |
| `rocksdb.num-files-at-level0` | The level 0 files of a column family. |
| `raft.wal.delayed_write_rate`, `raft.wal.write_stalled` | The same values, as metrics of `SolariumWAL`. |

## What to do about stalls

A stall means that compaction cannot keep up with your writes. You can:

- write fewer, larger level 0 files: raise `WriteBufferSize`;
- let compaction take more level 0 files at once: raise `Level0FileNumCompactionTrigger`;
- write fewer bytes: set `Compression = CompressionType.Lz4`;
- give a burst more room: raise the slowdown and stop triggers;
- run more compactions at once: raise `DbOptions.MaxBackgroundCompactions`.

More compaction threads keep level 0 lower, but they write more bytes. On a large store, they can also slow synced writes. See [Run several compactions at once](../guides/flushes-and-compaction.md#run-several-compactions-at-once).

A `RateLimiter` also slows compaction. Too low a rate lets level 0 grow until writes slow down and stop. When stalls start after you set a limiter, raise its rate.

## Differences from RocksDB

Write stalls differ from RocksDB in four ways: the delayed write rate is fixed, only the level 0 file count stalls writes, there is no `WriteOptions.no_slowdown`, and `Flush` does not wait for a stall to clear. See [Differences from RocksDB](../reference/rocksdb-differences.md#write-stalls).
