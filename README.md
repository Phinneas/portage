# Portage

Carry your site across. Intact.

Portage is an open source CLI migration toolkit that moves content sites to [Astro](https://astro.build). Each source platform is a **route** -- a tested crossing from one origin to Astro, with every field, asset, and URL accounted for.

## How it works

Three stages, run in order. Each is idempotent and writes to a manifest.

```bash
npx portage extract --from gatsby --source ./my-gatsby-site --to ./astro-project
npx portage transform --schema content-collections
npx portage load --images assets --redirects netlify
```

You pick one `--from` platform per run. Portage reads the source project, maps the content to Astro content collections, rewrites references, and writes a buildable Astro project.

## Routes

| Route | Status | Transfers | Spec |
| :--- | :--- | :--- | :--- |
| Ghost | Active | Posts, tags, authors, images, route slugs | [/routes/ghost](/routes/ghost) |
| Gatsby | Active | MDX/Markdown, GraphQL data layer, images, plugin config | [/routes/gatsby](/routes/gatsby) |
| Squarespace | Beta | Pages, blog posts, images, redirect maps. XML export. | [/routes/squarespace](/routes/squarespace) |
| Substack | Beta | Newsletter archive, posts, images, canonical URLs | [/routes/substack](/routes/substack) |
| Jekyll | Planned | Posts, collections, permalinks, Liquid tags | -- |
| Webflow | Planned | Content, assets, routes, CMS collections via API | -- |
| WordPress | Planned | Posts, pages, media, taxonomies, SEO metadata | -- |

Active routes have a fully written route spec and a working CLI extractor. Beta routes have a spec but no CLI implementation yet. Planned routes are on the build list.

## Integrity

- **No data loss** -- every field is checksummed on extract and verified on load. Mismatches halt the crossing.
- **No lock-in** -- output is plain Markdown, MDX, or JSON in your repository. Portage leaves no runtime behind.
- **Reversible** -- `--dry-run` prints the full plan without writing anything. Full diffs before any writes.
- **Inspectable** -- `portage.manifest.json` records every source file, transform, and output path. Commit it alongside your code.

## Project structure

This repo has two parts:

```
portage/
├── src/                    Astro marketing site (route spec pages)
│   ├── pages/
│   │   ├── index.astro         Landing page
│   │   └── routes/
│   │       ├── ghost.astro     Ghost → Astro route spec
│   │       ├── gatsby.astro    Gatsby → Astro route spec
│   │       ├── squarespace.astro
│   │       └── substack.astro
│   ├── components/
│   ├── layouts/
│   └── styles/
├── cli/                    CLI migration toolkit
│   ├── src/
│   │   ├── index.ts            CLI entry + commands
│   │   ├── manifest.ts         Types + read/write
│   │   ├── frontmatter.ts      Shared parsing, serialization, field mapping
│   │   ├── gatsby.ts           Gatsby project reader (extract)
│   │   └── astro-writer.ts     Astro project writer (transform + load)
│   ├── tests/
│   └── package.json
├── design-reference/       HTML prototypes for route spec pages
└── public/                 Static assets for the marketing site
```

## Development

**Marketing site:**

```bash
npm install
npm run dev          # http://localhost:4321
npm run build
```

**CLI:**

```bash
cd cli
npm install
npm run build        # compiles to cli/dist/
npm test             # 25 tests across 3 suites
```

**Run the CLI locally:**

```bash
cd cli
node dist/index.js extract --from gatsby --source ./tests/fixtures/gatsby-project --to ./output
node dist/index.js transform
node dist/index.js load
```

## CLI flags

### extract

| Flag | Values | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `--from` | `gatsby` (more coming) | required | Source platform |
| `--source` | path | `.` | Source project directory |
| `--to` | path | required | Target Astro project directory |
| `--queries` | glob | `src/templates/**/*.{js,jsx,ts,tsx}` | GraphQL query files (Gatsby only) |
| `--include-drafts` | flag | off | Carry draft content as `draft: true` |
| `--dry-run` | flag | off | Plan only; write nothing |
| `--gatsby-env` | `production` / `development` | `production` | Config evaluation environment |

### transform

| Flag | Values | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `--schema` | `content-collections` | `content-collections` | Target schema type |
| `--content` | `markdown` / `mdx` | `markdown` | Output body format |
| `--dry-run` | flag | off | Plan only; write nothing |

### load

| Flag | Values | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `--images` | `assets` / `public` / `localize-external` | `assets` | Image placement strategy |
| `--redirects` | `netlify` / `vercel` / `astro` | `astro` | Redirect map format |
| `--dry-run` | flag | off | Plan only; write nothing |

## Output structure

After a successful run, the target directory contains:

```
astro-project/
├── src/
│   ├── content/
│   │   ├── blog/              Migrated posts
│   │   └── pages/             Migrated pages
│   ├── assets/blog/           Localized images
│   └── content.config.ts      Zod schemas + glob loaders
├── astro.config.mjs           trailingSlash, integrations, redirects
├── portage.manifest.json      Full extract/transform/load ledger
└── public/                    Static assets + redirect maps
```

## License

MIT -- Salish Sea Consulting
