// @ts-check

import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Solarium',
  tagline: 'An embedded key-value store for .NET, written in managed code',
  favicon: 'img/favicon.png',

  url: 'https://solariumdb.github.io',
  baseUrl: '/',
  trailingSlash: true,

  organizationName: 'solariumdb',
  projectName: 'solariumdb.github.io',
  deploymentBranch: 'gh-pages',

  onBrokenLinks: 'throw',
  themes: ['@docusaurus/theme-mermaid'],
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  stylesheets: [
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
  ],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl: 'https://github.com/solariumdb/solariumdb.github.io/tree/main/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/logo.png',
      colorMode: {
        defaultMode: 'light',
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'Solarium',
        logo: {
          alt: 'Solarium Logo',
          src: 'img/logo-256.png',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'tutorialSidebar',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/andresgutierrez/solarium',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Introduction',
                to: '/docs/intro',
              },
              {
                label: 'Getting Started',
                to: '/docs/getting-started',
              },
              {
                label: 'API Reference',
                to: '/docs/reference/api',
              },
            ],
          },
          {
            title: 'Integrations',
            items: [
              {
                label: 'Kommander WAL',
                to: '/docs/integrations/kommander',
              },
              {
                label: 'Kahuna storage engine',
                to: '/docs/integrations/kahuna',
              },
            ],
          },
          {
            title: 'Project',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/andresgutierrez/solarium',
              },
              {
                label: 'Kommander',
                href: 'https://kahunakv.github.io/kommander.github.io/',
              },
              {
                label: 'Kahuna',
                href: 'https://kahunakv.github.io/',
              },
            ],
          },
        ],
        copyright: 'Copyright © 2026 Solarium.',
      },
      // Colors per color mode live in src/theme/Mermaid/index.js.
      mermaid: {
        theme: {light: 'base', dark: 'base'},
        options: {
          // Flat boxes without the drop shadows of Mermaid 12's default 'neo' look.
          look: 'classic',
          // Mermaid 12 wraps node labels at 120px; keep short labels on one line.
          // Space above subgraph titles so they do not crowd the top border.
          flowchart: {padding: 16, wrappingWidth: 220, subGraphTitleMargin: {top: 14, bottom: 6}},
          // Narrow, wrapped sequence diagrams keep their text legible when
          // scaled to the content column.
          sequence: {
            wrap: true,
            width: 130,
            actorMargin: 40,
            mirrorActors: false,
            actorFontSize: 15,
            messageFontSize: 15,
            noteFontSize: 14,
          },
        },
      },
      prism: {
        theme: prismThemes.oneLight,
        darkTheme: prismThemes.oneDark,
        additionalLanguages: ['csharp', 'bash', 'powershell'],
      },
    }),
};

export default config;
