---
sidebar_position: 1
---

# Column Families

A column family is a named, ordered key space in one database. Each column family has its own memtables, its own SSTables, and its own options. All column families of a database share one WAL and one sequence of sequence numbers. Because of this, one `WriteBatch` can write to several column families atomically.

Use this guide to plan your key spaces and to give each one the options that fit its data.

## When to use a column family

Use a separate column family when a group of keys:

- has a different write pattern, for example an append-only log beside small metadata rows;
- needs different options, for example a larger memtable or compression;
- must change atomically with other keys, but must not mix with them in the same key order.

Use key prefixes in one column family when the keys have the same pattern and the same options. A prefix costs nothing, and an iterator with an upper bound reads one prefix only.

Kommander uses both: the column families `default`, `metadata`, and `shard0` to `shard7`, and inside each shard, a key prefix for each partition.

## Create column families at open

You create column families only when you open the database:

```csharp
using SolariumDb db = SolariumDb.Open("./data",
    new DbOptions { CreateMissingColumnFamilies = true },
    columnFamilies: ["metadata", "log"]);
```

The rules:

- The `default` column family always exists. Its name is `ColumnFamily.DefaultName`.
- Every column family that exists already opens, even when `columnFamilies` does not name it.
- A name in `columnFamilies` that does not exist is created when `CreateMissingColumnFamilies` is true. When it is false, the default, `Open` fails.
- There is no call to create or drop a column family on an open database.

## Use a column family

```csharp
ColumnFamily log = db.GetColumnFamily("log");

db.Put("0001"u8, "entry"u8, log);
byte[]? value = db.Get("0001"u8, log);

using Iterator iterator = db.NewIterator(log);
```

`db.ColumnFamilies` lists every column family, the default one included. `db.DefaultColumnFamily` is the default one. A method that takes no `ColumnFamily` uses the default column family.

## Give each column family its own options

`DbOptions.DefaultColumnFamilyOptions` applies to every column family that `DbOptions.ColumnFamilyOptions` does not name:

```csharp
DbOptions options = new()
{
    CreateMissingColumnFamilies = true,
    DefaultColumnFamilyOptions = new ColumnFamilyOptions
    {
        WriteBufferSize = 16L * 1024 * 1024,
    },
    ColumnFamilyOptions = new Dictionary<string, ColumnFamilyOptions>
    {
        ["log"] = new ColumnFamilyOptions
        {
            WriteBufferSize = 128L * 1024 * 1024,
            MaxWriteBufferNumber = 3,
            Level0FileNumCompactionTrigger = 8,
            Level0SlowdownWritesTrigger = 28,
            Level0StopWritesTrigger = 44,
        },
        ["values"] = new ColumnFamilyOptions
        {
            Compression = CompressionType.Lz4,
        },
    },
};

using SolariumDb db = SolariumDb.Open("./data", options, ["log", "values"]);
```

Options are records with `init` properties. You set them each time you open the database. They are not stored in the directory, so you can change them between opens. [Options](../reference/options.md) lists each option with its default, and [Tuning](../operations/tuning.md) explains when to change it.

## Atomic batches across column families

```csharp
ColumnFamily log = db.GetColumnFamily("log");
ColumnFamily metadata = db.GetColumnFamily("metadata");

db.Write(new WriteBatch()
    .Put("0000000042"u8, entry, log)
    .Put("last-index"u8, "0000000042"u8, metadata),
    WriteOptions.Synced);
```

After a crash, the database holds both puts or neither of them. The shared WAL makes this possible: the batch is one WAL record.

## What column families share

| Shared by all column families | Separate for each column family |
| --- | --- |
| The WAL files | The memtables |
| The sequence numbers | The SSTables and their levels |
| The write stalls: one column family past a trigger slows the writes to all of them | The options |
| The flush thread and the compaction thread | The flush point in the manifest |

A column family with few writes can keep old WAL files alive, because its memtable still needs them. `DbOptions.MaxTotalWalSize` stops this: when the live WAL files are larger than this size, the column families that keep the oldest WAL file alive are flushed.
