import clsx from 'clsx';
import {useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

const proofPoints = [
  'Atomic batches',
  'Pure managed code',
  'Group commit',
  'Lock-free reads',
  'Power-loss tested',
  'MIT licensed',
];

const advantageCards = [
  {
    title: 'A complete storage engine in .NET',
    description:
      'One directory, column families, atomic batches across them, range deletes, ordered iterators, checkpoints, and leveled compaction.',
  },
  {
    title: 'No native library',
    description:
      'Solarium is managed code only. It runs on every platform that .NET 10 runs on, with no native binary to build, ship, or match to a runtime.',
  },
  {
    title: 'Built for a Raft log',
    description:
      'It covers what the Raft log of Kommander needs. Appended log files move down the levels with no rewrite, and a dead prefix goes away as whole files.',
  },
  {
    title: 'Fast writes from many threads',
    description:
      'Group commit shares WAL appends and flushes across writers, pipelines the next group, and lets each writer insert its own batch.',
  },
  {
    title: 'Reads that take no locks',
    description:
      'A read takes a version and a snapshot and searches a lock-free skip list and immutable SSTables. Fragmented range tombstones keep reads fast.',
  },
  {
    title: 'Recovery that tells damage from a crash',
    description:
      'Each WAL record carries the durable offset of its file, so recovery cuts a torn tail but refuses damage to data that was flushed.',
  },
];

const testingCards = [
  {
    title: 'Power-loss tests',
    description:
      'A storage environment keeps only what each file held at its last flush, then writes out what a power loss can leave, in order or sector by sector in any order.',
    linkLabel: 'Read about the crash tests',
    to: '/docs/operations/testing',
  },
  {
    title: 'Kill tests',
    description:
      'A real worker process gets SIGKILL at a random moment. Every acknowledged batch must be there after the reopen, and the batch in flight must be whole or absent.',
    linkLabel: 'Read about the kill tests',
    to: '/docs/operations/testing',
  },
  {
    title: 'Kommander conformance',
    description:
      'Solarium.Kommander passes the conformance suite of Kommander for WAL backends, and the tests run three-node Kommander clusters on it.',
    linkLabel: 'See the Kommander WAL',
    to: '/docs/integrations/kommander',
  },
  {
    title: 'Checkpoints under load',
    description:
      'A checkpoint is held at its first write while the source writes, flushes, and compacts. The copy must read as the source did when the checkpoint began.',
    linkLabel: 'Read about the checkpoint tests',
    to: '/docs/operations/testing#checkpoint-tests',
  },
];

const fitCards = [
  {
    title: 'Good fit',
    items: [
      'Embedded, ordered key-value data inside a .NET service',
      'Services that want a storage engine they can read and debug in C#',
      'The Raft log of a Kommander node',
      'The storage of a Kahuna node, with no native library',
    ],
  },
  {
    title: 'Not the target (yet)',
    items: [
      'A database server with a network protocol',
      'Workloads that need a shared block cache or memory budget',
      'Fast synced writes beside heavy compactions, without a rate limit tuned to your drive',
      'Production use without your own testing: Solarium is a young database',
    ],
  },
];

const projectUrls = {
  Kommander: 'https://kahunakv.github.io/kommander.github.io/',
  Kahuna: 'https://kahunakv.github.io/',
};

// Links each mention of Kommander and Kahuna in a text. A package name, such as Solarium.Kommander,
// stays plain text.
function withProjectLinks(text) {
  return text.split(/(?<!\.)\b(Kommander|Kahuna)\b/).map((part, index) =>
    index % 2 === 1 ? (
      <Link key={index} className={styles.projectLink} to={projectUrls[part]}>
        {part}
      </Link>
    ) : (
      part
    ),
  );
}

const integrations = [
  {
    name: 'Solarium.Kommander',
    to: '/docs/integrations/kommander',
    linkLabel: 'Read about Solarium.Kommander',
    description:
      'SolariumWAL, a Kommander IWAL. Pass it to RaftManager, with no change to Kommander and no native library.',
  },
  {
    name: 'Solarium.Kahuna',
    to: '/docs/integrations/kahuna',
    linkLabel: 'Read about Solarium.Kahuna',
    description:
      'The persistence backend and the Raft WAL of a Kahuna node, loaded with --extension-assembly.',
  },
];

// A small simulation of the engine for the hero panel. Writes fill the memtable and the WAL;
// a full memtable flushes to a level 0 file; compactions move files down to level 6; and the
// Raft log floor drops the oldest level 6 files. The base level is 4, as for a store of a few GB.
// Each file has an id, so a file that leaves collapses in place and the files after it slide left.
let nextFileId = 0;

function makeFiles(count) {
  return Array.from({length: count}, () => ({id: nextFileId++, gone: false}));
}

const initialEngine = {
  mem: 64,
  walResidual: 6,
  l0: makeFiles(2),
  l4: makeFiles(2),
  l5: makeFiles(4),
  l6: makeFiles(9),
  step: null,
  sequence: 1284019,
};

// For each step: the level it reads, how many of its oldest files take part, and its label.
const steps = {
  flush: {label: 'FLUSH → L0'},
  l0: {level: 'l0', files: Infinity, label: 'COMPACT L0 → L4'},
  l4: {level: 'l4', files: 2, label: 'COMPACT L4 → L5'},
  l5: {level: 'l5', files: 3, label: 'MOVE L5 → L6'},
  floor: {level: 'l6', files: 4, label: 'DROP FILES BELOW FLOOR'},
};

const live = (files) => files.filter((file) => !file.gone).length;
const leave = (files, count) => files.map((file, index) => (index < count ? {...file, gone: true} : file));

function nextStep(engine) {
  if (live(engine.l0) >= 3) return 'l0';
  if (live(engine.l4) >= 3) return 'l4';
  if (live(engine.l5) >= 6) return 'l5';
  if (live(engine.l6) >= 11) return 'floor';
  return null;
}

function advanceEngine(engine) {
  const next = {
    ...engine,
    sequence: engine.sequence + 48 + Math.floor(Math.random() * 40),
    // Files that left on the last tick have finished their exit transition.
    l0: engine.l0.filter((file) => !file.gone),
    l4: engine.l4.filter((file) => !file.gone),
    l5: engine.l5.filter((file) => !file.gone),
    l6: engine.l6.filter((file) => !file.gone),
    step: null,
  };

  // A step marked on the last tick completes now, so its files glow for one tick first.
  switch (engine.step) {
    case 'l0':
      return {...next, l0: leave(next.l0, Infinity), l4: [...next.l4, ...makeFiles(1)]};
    case 'l4':
      return {...next, l4: leave(next.l4, 2), l5: [...next.l5, ...makeFiles(2)]};
    case 'l5':
      return {...next, l5: leave(next.l5, 3), l6: [...next.l6, ...makeFiles(3)]};
    case 'floor':
      return {...next, l6: leave(next.l6, 4)};
    default:
      break;
  }

  next.walResidual = Math.max(0, engine.walResidual - 5);
  next.mem = engine.mem + 9 + Math.random() * 8;
  if (next.mem >= 100) {
    // The flush empties the memtable; the old WAL file goes away once the table is saved.
    next.mem = 3;
    next.walResidual = 24;
    next.l0 = [...next.l0, ...makeFiles(1)];
    next.step = 'flush';
    return next;
  }

  next.step = nextStep(next);
  return next;
}

function walFill(engine) {
  return Math.min(100, Math.max(4, engine.walResidual + engine.mem * 0.78));
}

function useEngineSimulation() {
  const [engine, setEngine] = useState(initialEngine);

  useEffect(() => {
    // With reduced motion, the panel still changes, but more slowly. The CSS turns off the
    // transitions, so each change happens at once, with no sliding, scaling, or fading.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setInterval(() => setEngine(advanceEngine), reduced ? 2500 : 850);
    return () => window.clearInterval(timer);
  }, []);

  return engine;
}

function FileRow({name, level, engine}) {
  const step = steps[engine.step];
  const busy = step?.level === level ? step.files : 0;
  return (
    <div className={styles.levelRow}>
      <span className={styles.levelName}>{name}</span>
      <div className={styles.fileRow}>
        {engine[level].map((file, index) => (
          <span
            key={file.id}
            className={clsx(
              styles.sstFile,
              file.gone && styles.sstFileGone,
              !file.gone && index < busy && styles.sstFileBusy,
            )}
          />
        ))}
      </div>
    </div>
  );
}

function SectionHeading({eyebrow, title, subtitle}) {
  return (
    <div className={styles.sectionHeading}>
      <p className={styles.sectionEyebrow}>{eyebrow}</p>
      <Heading as="h2" className={styles.sectionTitle}>
        {withProjectLinks(title)}
      </Heading>
      {subtitle ? <p className={styles.sectionSubtitle}>{withProjectLinks(subtitle)}</p> : null}
    </div>
  );
}

function HomepageHeader() {
  const logoUrl = useBaseUrl('/img/logo.png');
  const engine = useEngineSimulation();

  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className={clsx('container', styles.heroInner)}>
        <div className={styles.heroContent}>
          <p className={styles.heroEyebrow}>Open-source storage engine for C# and .NET</p>
          <Heading as="h1" className={styles.heroTitle}>
            Durable key-value storage for .NET
          </Heading>
          <p className={styles.heroSubtitle}>
            Solarium is an embedded key-value store, written in managed code. It gives your
            service a write-ahead log, column families, atomic batches, range deletes, and
            leveled compaction, in a design inspired by RocksDB. It needs no native library.
          </p>
          <div className={styles.buttons}>
            <Link className={styles.primaryButton} to="/docs/intro/">
              Get started
            </Link>
            <Link className={styles.secondaryButton} to="/docs/why-solarium">
              Why Solarium
            </Link>
            <Link className={styles.secondaryButton} to="/docs/operations/benchmarks">
              Benchmarks
            </Link>
          </div>
          <div className={styles.proofGrid}>
            {proofPoints.map((point) => (
              <div key={point} className={styles.proofPill}>
                {point}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.heroMedia} aria-hidden="true">
          <div className={styles.systemPanel}>
            <div className={styles.panelBar}>
              <span>db / ./data / shard3</span>
              <span className={styles.panelState}>● WRITABLE</span>
            </div>
            <div className={styles.treeMap}>
              <div className={styles.walRow}>
                <span className={styles.levelName}>WAL</span>
                <div className={styles.walTrack}>
                  <span className={styles.walFill} style={{width: `${walFill(engine)}%`}} />
                </div>
              </div>
              <div className={styles.levelRow}>
                <span className={styles.levelName}>MEM</span>
                <div className={clsx(styles.memtable, engine.step === 'flush' && styles.memtableFlushed)}>
                  <span className={styles.memtableFill} style={{width: `${engine.mem}%`}} />
                </div>
              </div>
              <FileRow name="L0" level="l0" engine={engine} />
              <FileRow name="L4" level="l4" engine={engine} />
              <FileRow name="L5" level="l5" engine={engine} />
              <FileRow name="L6" level="l6" engine={engine} />
            </div>
            <div className={styles.panelFooter}>
              <span key={engine.step ?? 'commit'} className={styles.activity}>
                {engine.step ? steps[engine.step].label : 'GROUP COMMIT'}
              </span>
              <span key={engine.sequence} className={styles.sequence}>
                SEQUENCE {engine.sequence.toLocaleString('en-US')}
              </span>
            </div>
          </div>
          <img src={logoUrl} alt="" className={styles.heroLogo} />
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} documentation`}
      description="Documentation for Solarium, an embedded key-value store for .NET, written in managed code.">
      <HomepageHeader />
      <main>
        <section className={styles.primarySection}>
          <div className="container">
            <SectionHeading
              eyebrow="Why use it"
              title="A log-structured store you can read end to end"
              subtitle="Solarium gives Raft logs and key-value stores a log-structured engine in C# that you can step through in a debugger."
            />
            <div className={styles.cardGrid}>
              {advantageCards.map((card) => (
                <div key={card.title} className={styles.advantageCard}>
                  <Heading as="h3" className={styles.cardTitle}>
                    {withProjectLinks(card.title)}
                  </Heading>
                  <p className={styles.cardDescription}>{withProjectLinks(card.description)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.bandSection}>
          <div className="container">
            <SectionHeading
              eyebrow="Integrations"
              title="A drop-in WAL for Kommander and Kahuna"
              subtitle="Solarium exists to be a durable log store for Kommander. Two packages connect it to Kommander and Kahuna with no change to either."
            />
            <div className={styles.usedByGrid}>
              {integrations.map((project) => (
                <div key={project.name} className={styles.usedByCard}>
                  <Heading as="h3" className={styles.cardTitle}>
                    {project.name}
                  </Heading>
                  <p className={styles.cardDescription}>{withProjectLinks(project.description)}</p>
                  <Link className={styles.inlineLink} to={project.to}>
                    {project.linkLabel}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.primarySection}>
          <div className="container">
            <SectionHeading
              eyebrow="How it is tested"
              title="Tested against power loss and crashes"
              subtitle="A storage engine is only as good as its recovery. The tests cut the power and kill processes at random points, and then check every acknowledged write."
            />
            <div className={styles.testingGrid}>
              {testingCards.map((card) => (
                <div key={card.title} className={styles.calloutCard}>
                  <Heading as="h3" className={styles.cardTitle}>
                    {withProjectLinks(card.title)}
                  </Heading>
                  <p className={styles.cardDescription}>{withProjectLinks(card.description)}</p>
                  <Link className={styles.inlineLink} to={card.to}>
                    {card.linkLabel}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.bandSection}>
          <div className="container">
            <SectionHeading
              eyebrow="What it is"
              title="Is Solarium right for your project?"
              subtitle="Solarium is a brand-new database. Use it where its scope matches yours, and read the list of what is not done yet."
            />
            <div className={styles.fitGrid}>
              {fitCards.map((card) => (
                <div key={card.title} className={styles.fitCard}>
                  <Heading as="h3" className={styles.cardTitle}>
                    {withProjectLinks(card.title)}
                  </Heading>
                  <ul className={styles.fitList}>
                    {card.items.map((item) => (
                      <li key={item}>{withProjectLinks(item)}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.primarySection}>
          <div className="container">
            <SectionHeading
              eyebrow="Inside the engine"
              title="Every part of the engine explained"
              subtitle="The architecture pages describe each part of Solarium in the order that a write and a read go through it."
            />
            <div className={styles.calloutRow}>
              <div className={styles.calloutCard}>
                <Heading as="h3" className={styles.cardTitle}>
                  Group commit
                </Heading>
                <p className={styles.cardDescription}>
                  How one leader writes the batches of many writers to the WAL in one append, and
                  how pipelined memtable stages keep the next group moving.
                </p>
                <Link className={styles.inlineLink} to="/docs/architecture/write-path">
                  Read about the write path
                </Link>
              </div>
              <div className={styles.calloutCard}>
                <Heading as="h3" className={styles.cardTitle}>
                  Leveled compaction
                </Heading>
                <p className={styles.cardDescription}>
                  Seven levels with dynamic level sizing, appended keys that move down with no
                  rewrite, and whole-file drops with DeleteFilesInRange.
                </p>
                <Link className={styles.inlineLink} to="/docs/architecture/compaction">
                  Read about compaction
                </Link>
              </div>
              <div className={styles.calloutCard}>
                <Heading as="h3" className={styles.cardTitle}>
                  WAL and recovery
                </Heading>
                <p className={styles.cardDescription}>
                  The WAL format, the durable offset in each record, and the rules that recovery
                  uses after a crash or a power loss.
                </p>
                <Link className={styles.inlineLink} to="/docs/architecture/wal-and-recovery">
                  Read about recovery
                </Link>
              </div>
            </div>
            <div className={styles.footerActions}>
              <Link className={styles.primaryButton} to="/docs/getting-started">
                Open a database
              </Link>
              <Link className={styles.secondaryButton} to="/docs/architecture/overview">
                Explore the architecture
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
