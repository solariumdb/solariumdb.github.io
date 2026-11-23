---
sidebar_position: 1
---

# Column Families

Column families let you store different kinds of data in one database, each in its own sorted key space, and change them together. For example, a Raft log has its entries in one column family and its metadata in another, and one write batch updates both atomically. If you know SQLite, a column family is like a separate table in one database file.

Memtables, SSTables, and options are separate for each column family. All column families of a database share one WAL and one sequence of sequence numbers. The shared WAL makes a batch across column families atomic.

## When to use a column family

A group of keys needs a separate column family when at least one of these conditions is true.

- The keys have a different write pattern, for example an append-only log beside small metadata rows.
- The keys need different options, for example a larger memtable or compression.
- The keys must change atomically with other keys, but must not mix with them in the same key order.

Use key prefixes in one column family when the keys have the same pattern and the same options. A prefix does not add a memtable or an SSTable, and an iterator with an upper bound reads one prefix only.

Kommander uses both. Its column families are `default`, `metadata`, and `shard0` to `shard7`. Each partition has a key prefix in its shard.

## Create column families at open

Column families are created when you open the database. Set `CreateMissingColumnFamilies` and list the names.

```csharp
using SolariumDb db = SolariumDb.Open("./data",
    new DbOptions { CreateMissingColumnFamilies = true },
    columnFamilies: ["metadata", "log"]);
```

There is no call to create or drop a column family on an open database. The names that you give to `Open` follow these rules.

- The `default` column family always exists. Its name is `ColumnFamily.DefaultName`.
- `Open` opens all the column families that exist already, even those that `columnFamilies` does not name.
- A name in `columnFamilies` that does not exist is created when `CreateMissingColumnFamilies` is true. When it is false, the default, `Open` fails.

## Use a column family

```csharp
ColumnFamily log = db.GetColumnFamily("log");

db.Put("0001"u8, "entry"u8, log);
byte[]? value = db.Get("0001"u8, log);

using Iterator iterator = db.NewIterator(log);
```

`db.ColumnFamilies` lists all the column families, the default one included. `db.DefaultColumnFamily` is the default one. A method that takes no `ColumnFamily` uses the default column family.

## Give each column family its own options

`DbOptions.ColumnFamilyOptions` gives options to a column family by its name. `DbOptions.DefaultColumnFamilyOptions` applies to all the others.

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

Options are records with `init` properties. You set them each time you open the database. They are not stored in the directory, and you can change them between opens. [Options](../reference/options.md) lists each option with its default, and [Tuning](../operations/tuning.md) explains when to change it.

## Atomic batches across column families

```csharp
ColumnFamily log = db.GetColumnFamily("log");
ColumnFamily metadata = db.GetColumnFamily("metadata");

db.Write(new WriteBatch()
    .Put("0000000042"u8, entry, log)
    .Put("last-index"u8, "0000000042"u8, metadata),
    WriteOptions.Synced);
```

After a crash, either both puts are in the database or neither of them is. The shared WAL makes this possible: the batch is one WAL record.

## What column families share

| Shared by all column families | Separate for each column family |
| --- | --- |
| The WAL files | The memtables |
| The sequence numbers | The SSTables and their levels |
| The write stalls: one column family past a trigger slows the writes to all of them | The options |
| The flush thread and the compaction threads | The flush point in the manifest |

The memtable of a column family with few writes can need old WAL files for a long time. These files cannot be deleted until it flushes. `DbOptions.MaxTotalWalSize` stops this. When the live WAL files are larger than this size, the column families that need the oldest WAL file are flushed.
