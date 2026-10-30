# Solarium Documentation

This repository contains the Docusaurus documentation site for [Solarium](https://github.com/solariumdb/solariumdb), an embedded key-value store for .NET with the API and semantics of RocksDB.

## Development

```shell
npm install
npm run start
```

## Build

```shell
npm run build
```

## Deploy

Each push to `main` builds the site and deploys it to GitHub Pages, through the workflow in `.github/workflows/deploy.yml`. The site is at https://solariumdb.github.io/.

The repository needs one setting, which an admin of the repository makes once: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

To deploy without a push, run the workflow by hand from the **Actions** tab.
