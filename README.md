# Portage

Carry your site across. Intact.

Portage is an open source CLI migration toolkit that moves content sites between platforms. Each source-destination pair is a **route** -- a tested crossing from one origin to another, with every field, asset, and URL accounted for.

Most routes migrate to [Astro](https://astro.build) content collections. Some routes migrate between headless CMS platforms (Ghost → Payload, Contentful → Sanity, Storyblok → Keystatic). The three-stage pipeline is the same regardless of destination.

## How it works

Three stages, run in order. Each is idempotent and writes to a manifest.

```bash
npx portage extract --from gatsby --source ./my-gatsby-site --to ./astro-project
npx portage transform --schema content-collections
npx portage load --images assets --redirects netlify
```

You pick one `--from` platform per run. Portage reads the source project, maps the content to the target format, rewrites references, and writes the output. For Astro routes, that's Markdown/MDX content collections. For headless CMS routes, that's seed scripts, NDJSON files, or YAML/JSON content files.

## Routes

### Astro destinations

| Route | Status | Transfers | Spec |
| :--- | :--- | :--- | :--- |
| Ghost → Astro | Active | Posts, tags, authors, images, route slugs | [/routes/ghost](/routes/ghost) |
| Gatsby → Astro | Active | MDX/Markdown, GraphQL data layer, images, plugin config | [/routes/gatsby](/routes/gatsby) |
| Squarespace → Astro | Active | Pages, blog posts, images, redirect maps. XML export. | [/routes/squarespace](/routes/squarespace) |
| Jekyll → Astro | Active | Posts, collections, permalinks, Liquid tags, _config.yml | [/routes/jekyll](/routes/jekyll) |
| Next.js → Astro | Active | MDX, getStaticProps, next/image, next/link, pages router | [/routes/next](/routes/next) |
| Substack → Astro | Beta | Newsletter archive, posts, images, canonical URLs | [/routes/substack](/routes/substack) |
| Webflow → Astro | Planned | Content, assets, routes, CMS collections via API | -- |
| WordPress → Astro | Planned | Posts, pages, media, taxonomies, SEO — highest plugin variance, deferred pending lower-variance route maturation | -- |

### Headless CMS destinations

| Route | Status | Transfers | Spec |
| :--- | :--- | :--- | :--- |
| Ghost → Payload | Active | Posts, pages, tags, authors, media, Lexical content. Seed script. | [/routes/ghost-payload](/routes/ghost-payload) |
| Contentful → Sanity | Beta | Content types, Rich Text, entry links, assets, locales. NDJSON import. | [/routes/contentful-sanity](/routes/contentful-sanity) |
| Storyblok → Keystatic | Beta | Components, bloks, Rich Text, assets, story slugs. File writes. | [/routes/storyblok-keystatic](/routes/storyblok-keystatic) |

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
│   │       ├── ghost.astro           Ghost → Astro route spec
│   │       ├── ghost-payload.astro   Ghost → Payload route spec
│   │       ├── gatsby.astro         Gatsby → Astro route spec
│   │       ├── squarespace.astro     Squarespace → Astro route spec
│   │       ├── jekyll.astro         Jekyll → Astro route spec
│   │       ├── next.astro           Next.js → Astro route spec
│   │       ├── contentful-sanity.astro  Contentful → Sanity route spec
│   │       └── storyblok-keystatic.astro Storyblok → Keystatic route spec
│   ├── components/
│   ├── layouts/
│   └── styles/
├── cli/                    CLI migration toolkit
│   ├── src/
│   │   ├── index.ts            CLI entry + commands
│   │   ├── manifest.ts         Zod schemas + read/write
│   │   ├── frontmatter.ts      Shared parsing, serialization, field mapping
│   │   ├── gatsby.ts           Gatsby project reader (extract)
│   │   ├── jekyll.ts           Jekyll project reader (extract)
│   │   ├── squarespace.ts      Squarespace export reader (extract)
│   │   ├── next.ts             Next.js pages router reader (extract)
│   │   ├── wxr-parser.ts       Shared WXR XML parser (Squarespace + WordPress)
│   │   └── astro-writer.ts     Astro project writer (transform + load)
│   ├── docs/adr/              Architectural decision records
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
npm test             # 158 tests across 6 suites
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
| `--from` | `gatsby` / `jekyll` / `squarespace` / `next` | required | Source platform |
| `--source` | path | `.` | Source project directory |
| `--to` | path | required | Target directory |
| `--export` | path | -- | Squarespace WXR export file (required for `--from squarespace`) |
| `--router` | `pages` / `app` | `pages` | Next.js router type |
| `--queries` | glob | `src/templates/**/*.{js,jsx,ts,tsx}` | GraphQL query files (Gatsby only) |
| `--hero` | `first-image` / `none` | `first-image` | Squarespace hero derivation strategy |
| `--permalink-style` | `flat` / `original` / `preserve` | `flat` | Jekyll permalink handling |
| `--include-drafts` | flag | off | Carry draft content as `draft: true` |
| `--dry-run` | flag | off | Plan only; write nothing |
| `--gatsby-env` | `production` / `development` | `production` | Config evaluation environment (Gatsby only) |

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

Output depends on the destination platform. For Astro routes:

```
astro-project/
├── src/
│   ├── content/
│   │   ├── blog/              Migrated posts
│   │   └── pages/            Migrated pages
│   ├── assets/blog/           Localized images
│   └── content.config.ts      Zod schemas + glob loaders
├── astro.config.mjs           trailingSlash, integrations, redirects
├── portage.manifest.json      Full extract/transform/load ledger
└── public/                    Static assets + redirect maps
```

For headless CMS routes, the output varies by destination:
- **Ghost → Payload**: `src/seed.ts` (Local API seed script) + `media/` directory
- **Contentful → Sanity**: `import/data.ndjson` + `import/assets/` + `import.tar.gz`
- **Storyblok → Keystatic**: `content/` directory (YAML/JSON files) + `keystatic.config.ts`

## License

MIT -- Salish Sea Consulting
