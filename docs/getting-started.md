---
sidebar_position: 4
---

# Getting Started

This page takes you from an empty project to a database with data in two column families. You open a database and write an atomic batch. Then you read a key, iterate over a key range, and close the database safely. After that, continue to the [guides](guides/column-families.md) for each feature.

## Requirements

- The .NET 10 SDK. The Solarium repository pins it in `global.json`.
- For the optional io_uring storage environment: Linux 6.1 or later. See [io_uring on Linux](guides/io-uring.md).

## Add Solarium to your project

The store is the `SolariumDb` package on NuGet.

```shell
dotnet add package SolariumDb
```

The other packages are optional. Add one only if you need it.

```shell
# The io_uring storage environment (Linux 6.1 or later)
dotnet add package SolariumDb.IoUring

# SolariumWAL, the Kommander WAL backend
dotnet add package SolariumDb.Kommander
```

The package IDs start with `SolariumDb`. The ID `Solarium` on nuget.org belongs to a different project. Do not install it. The namespaces are `Solarium`, `Solarium.IoUring`, and `Solarium.Kommander`.

:::note Docs follow the main branch
These docs follow the main branch of the [repository](https://github.com/solariumdb/solariumdb). A feature can reach the main branch before it reaches NuGet. To use the newest code, clone the repository and reference the projects, for example `dotnet add reference ../solariumdb/src/Solarium/Solarium.csproj`.
:::

You can also build and test the repository itself.

```shell
git clone https://github.com/solariumdb/solariumdb.git
cd solariumdb
dotnet build
dotnet test
```

## Open a database

A database is one directory. `SolariumDb.Open` creates the directory when it does not exist. `DbOptions.CreateIfMissing` controls this, and it is true by default.

```csharp
using Solarium;

using SolariumDb db = SolariumDb.Open("./data",
    new DbOptions { CreateMissingColumnFamilies = true },
    columnFamilies: ["metadata"]);
```

The call names the directory and the column families. The `using` declaration closes the database.

- `"./data"` is the database directory. Only one open database can use it at a time. A `LOCK` file in the directory makes sure of this.
- `CreateMissingColumnFamilies = true` creates the column families in `columnFamilies` that do not exist yet. When it is false, the default, a missing column family is an error, as in RocksDB.
- `columnFamilies: ["metadata"]` names the column families that must exist. The column families that exist already open too, even when you do not name them. The `default` column family always exists.
- `using` disposes the database at the end of the scope. `Dispose` flushes the current WAL file. This means that every write before a clean close survives a power loss after it.

Column families are created when you open the database. There is no call to create or drop a column family on an open database.

## Get a column family

```csharp
ColumnFamily metadata = db.GetColumnFamily("metadata");
```

`GetColumnFamily` throws `KeyNotFoundException` when there is no column family with that name. Each read and write method takes an optional `ColumnFamily`. When you pass none, the method uses the default column family.

## Write

`Put` writes one key.

```csharp
db.Put("user:42"u8, "Ada"u8);
```

A `WriteBatch` groups operations into one atomic write, here across two column families.

```csharp
db.Write(new WriteBatch()
    .Put("log:0001"u8, "entry"u8)
    .Put("last"u8, "0001"u8, metadata),
    WriteOptions.Synced);
```

The batch applies all its operations, or none of them. `WriteOptions.Synced` flushes the WAL before `Write` returns. This means that the batch survives a power loss. An unsynced write, the default, survives a process crash, but a power loss can lose it. [Writes and Batches](guides/writes-and-batches.md) explains the choice.

Keys and values are bytes. The `u8` suffix of C# makes a UTF-8 byte span from a string literal. Keys sort by their bytes, as unsigned values.

## Read

```csharp
byte[]? value = db.Get("log:0001"u8);
byte[]? last = db.Get("last"u8, metadata);
```

`Get` returns null when the key is absent or deleted. The returned array belongs to you.

`MultiGet` reads several keys at one snapshot.

```csharp
byte[]?[] values = db.MultiGet(["user:42"u8.ToArray(), "user:43"u8.ToArray()]);
```

## Iterate over a key range

```csharp
using System.Text;

using Iterator iterator = db.NewIterator(options: new ReadOptions { IterateUpperBound = "log;"u8.ToArray() });
for (iterator.Seek("log:"u8); iterator.Valid(); iterator.Next())
    Console.WriteLine(Encoding.UTF8.GetString(iterator.Key()));
```

The iterator reads a snapshot. It sees the data as it was when you created it. `Seek` moves to the first key at or after its target. The iterator stops before the first key at or after `IterateUpperBound`. Here, the bound ends the `log:` prefix, as `;` is the byte after `:`.

Dispose each iterator. Until you dispose it, the SSTables of its snapshot stay open.

## Delete

```csharp
db.Delete("user:42"u8);
db.DeleteRange("log:0000"u8, "log:0001"u8);
```

`DeleteRange` deletes every key from the begin key up to the end key. The begin key is included and the end key is excluded. It writes one range tombstone for the range.

## The complete program

```csharp
using System.Text;
using Solarium;

using SolariumDb db = SolariumDb.Open("./data",
    new DbOptions { CreateMissingColumnFamilies = true },
    columnFamilies: ["metadata"]);

ColumnFamily metadata = db.GetColumnFamily("metadata");

db.Write(new WriteBatch()
    .Put("log:0001"u8, "first"u8)
    .Put("log:0002"u8, "second"u8)
    .Put("last"u8, "0002"u8, metadata),
    WriteOptions.Synced);

Console.WriteLine(Encoding.UTF8.GetString(db.Get("last"u8, metadata)!));

using Iterator iterator = db.NewIterator(options: new ReadOptions { IterateUpperBound = "log;"u8.ToArray() });
for (iterator.Seek("log:"u8); iterator.Valid(); iterator.Next())
    Console.WriteLine($"{Encoding.UTF8.GetString(iterator.Key())} = {Encoding.UTF8.GetString(iterator.Value())}");

db.DeleteRange("log:0001"u8, "log:0002"u8);
Console.WriteLine(db.Get("log:0001"u8) is null ? "log:0001 is deleted" : "log:0001 is still there");
```

The program prints the last id and the two log entries. The last line shows that the range delete removed the first entry.

```text
0002
log:0001 = first
log:0002 = second
log:0001 is deleted
```

Run the program a second time. The WAL replays at open, and the database has the data of the first run.

## What is in the directory

After the first run, the data is in a WAL file. An SSTable appears after a memtable flush.

| File | Content |
| --- | --- |
| `LOCK` | An exclusive lock. Only one open database can use the directory. |
| `FORMAT` | The format version. |
| `MANIFEST` | The column families, their SSTables, and the live WAL files. |
| `NNNNNN.log` | A WAL file. |
| `NNNNNN.sst` | An SSTable, after a memtable flush. |

Do not change these files by hand. [Data Directory](reference/data-directory.md) describes each one.

## Next steps

- [Column Families](guides/column-families.md): plan your key spaces and set the options of each one.
- [Writes and Batches](guides/writes-and-batches.md): choose between synced and unsynced writes.
- [Reads and Iterators](guides/reads-and-iterators.md): snapshots, bounds, and backward iteration.
- [Solarium.Kommander](integrations/kommander.md): use Solarium as the Raft log of Kommander.
