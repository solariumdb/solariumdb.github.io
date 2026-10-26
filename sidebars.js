// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  tutorialSidebar: [
    'intro',
    'why-solarium',
    'getting-started',
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/column-families',
        'guides/writes-and-batches',
        'guides/reads-and-iterators',
        'guides/range-deletes',
        'guides/flushes-and-compaction',
        'guides/checkpoints',
        'guides/io-uring',
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      items: ['integrations/kommander', 'integrations/kahuna'],
    },
    {
      type: 'category',
      label: 'Operating Solarium',
      items: [
        'operations/durability',
        'operations/tuning',
        'operations/write-stalls',
        'operations/diagnostics',
        'operations/storage-failures',
        'operations/testing',
        'operations/benchmarks',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/api',
        'reference/options',
        'reference/properties',
        'reference/data-directory',
        'reference/rocksdb-differences',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/write-path',
        'architecture/read-path',
        'architecture/memtable',
        'architecture/flushes',
        'architecture/compaction',
        'architecture/sstables',
        'architecture/wal-and-recovery',
        'architecture/checkpoints',
        'architecture/storage-environments',
      ],
    },
  ],
};

export default sidebars;
