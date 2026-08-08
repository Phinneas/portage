# Migration Report Schema — `migration-report.json`

**Status:** Normative · **Version:** 1.0 · **Owner:** Portage (open standard — tool-agnostic)

A tiny, tool-agnostic, machine-readable record of a content migration: every source URL
and where it landed. Any migration tool can produce it; any auditor (notably
[LinkCanary](https://github.com/LinkCanary/LinkCanary)) can ingest it to verify that
migrated URLs actually resolve on the destination site.

The standard is deliberately small: six required fields per record, a closed `status`
vocabulary, and a header that gives a consumer everything it needs to resolve and verify.
Everything else is optional and must never break a conforming consumer.

---

## 1. Purpose

After a migration there are two things to know about every URL the site used to serve:

1. **Where did it go?** — the destination path (or the fact that it went nowhere).
2. **Did it arrive?** — does the destination actually resolve, and does the source behave
   as declared (redirect, gone, or gone-live)?

This file answers (1) definitively and gives (2) a complete, machine-checkable contract.
LinkCanary ingests the file, crawls the destination, and reports each source URL as
*verified*, *missing*, or *mismatched* — turning "we migrated everything" into
"here is proof, per URL."

## 2. Conventions

- **Filename:** `migration-report.json`, written to the root of the migration output
  directory. Fixed name so consumers can find it deterministically.
- **Encoding:** UTF-8 JSON, no BOM, newline-terminated.
- **Naming:** all fields are `snake_case`. This is the stable convention of the standard.
- **Versioning:** the document carries a `version` field (`"1.0"` for this standard).
  Producers write exactly `"1.0"`. Consumers reject unknown versions with a clear error.
- **URLs** are absolute (`source_url`, `redirect_target`); **paths** are absolute and
  server-relative (`destination_path`, starts with `/`).

## 3. Document structure

```json
{
  "version": "1.0",
  "generated_by": "portage@0.9.2",
  "generated_at": "2026-08-08T19:04:12Z",
  "destination_base_url": "https://example.com",
  "destination_platform": "astro",
  "records": []
}
```

### 3.1 Header fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `version` | string | yes | Schema version. MUST be `"1.0"` for this standard. |
| `generated_by` | string | yes | Tool identifier and version, e.g. `portage@0.9.2`. Free-form but SHOULD be `name@semver`. |
| `generated_at` | string | yes | ISO 8601 UTC timestamp of report generation. |
| `destination_base_url` | string | yes | Origin (plus optional path prefix) of the destination site. Consumers resolve every `destination_path` against this. MUST NOT end with `/`. |
| `destination_platform` | string | yes | Destination platform identifier (see §4.1). |
| `records` | array | yes | Zero or more records (§4). One record per migrated source URL. May be empty (nothing was carried). |

Unknown top-level fields are permitted and MUST be ignored by consumers
(forward-compatibility rule, §8).

## 4. Records

Every record describes exactly **one source URL** and its disposition after migration.
The six fields below are required and are the entire core contract.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `source_platform` | string | yes | Platform the content came from (§4.1). |
| `source_url` | string | yes | The original, absolute URL on the source site (§4.2). MUST be unique across records. |
| `destination_path` | string \| null | yes | Where the content landed, as an absolute server-relative path. `null` when nothing was written. MUST start with `/`. |
| `status` | string | yes | Disposition of this URL after migration (§4.3). Closed vocabulary. |
| `images_rehosted` | boolean | yes | Whether every image referenced by the item now lives on the destination (§4.4). |
| `links_rewritten` | boolean | yes | Whether every internal link in the item now points at the destination (§4.5). |

### 4.1 Platform identifiers

Identifiers are lowercase, `[a-z0-9-]`. Registered vocabulary:

`ghost` · `gatsby` · `squarespace` · `substack` · `jekyll` · `next` · `wordpress` ·
`webflow` · `contentful` · `storyblok` · `medium` · `notion` · `astro` · `custom`

The vocabulary is open: tools MAY use identifiers outside the list, but SHOULD register
new ones with the standard. Identifiers are informational for verification (the resolution
contract does not depend on them) — except `destination_platform`, which tells the consumer
how to interpret `destination_path`.

### 4.2 URL normalization

Producers MUST emit normalized URLs so that both producer and consumer agree on identity:

- strip URL fragments (`#section` never reaches the server),
- lowercase scheme and host; preserve path case,
- collapse duplicate slashes in the path,
- resolve dot-segments (`/a/./b` → `/a/b`),
- preserve the query string exactly.

### 4.3 `status` — closed vocabulary

MUST be exactly one of:

| Status | Meaning | Expected resolution (what LinkCanary verifies) |
| :--- | :--- | :--- |
| `migrated` | Content carried to `destination_path`. | `destination_path` → **2xx**. The `source_url` SHOULD redirect (3xx) to the destination or return 404/410. |
| `redirected` | Content was not carried directly; the URL now points elsewhere. `destination_path` is the target path (or `null`); `redirect_target` SHOULD carry the final URL. | `source_url` → **3xx chain ending 2xx**. `destination_path` (if present) → **2xx**. |
| `quarantined` | Content deliberately held back from output (draft, review flag, transform issue) pending a decision. `destination_path` is `null`. | No destination. `source_url` → **4xx/5xx** (gone). If it still resolves 2xx, that is an alert: content that should be offline is live. |
| `failed` | The migration of this item errored. `destination_path` may be missing or incomplete. | Flag for human review. If `destination_path` resolves 2xx, verify content completeness manually. |
| `excluded` | Intentionally not migrated (policy: deleted content, canonical merged elsewhere, out of scope). `destination_path` is `null`. | No destination. `source_url` → **4xx/5xx**. Same live-alert rule as `quarantined`. |

`quarantined` differs from `excluded` operationally: quarantined items need a human
decision; excluded items are final.

### 4.4 `images_rehosted`

`true` — every image referenced by this item is served from the destination (downloaded and
rehosted, or already local). `false` — at least one image still points at the source or a
remote host, or failed to download.

An item with no images MUST be reported `true` (vacuously: nothing remains external).
When `false`, producers SHOULD include `asset_counts` (§5) so the failure is quantified.

### 4.5 `links_rewritten`

`true` — every internal link/reference in this item points at a destination-relative path
or a correct destination URL; none point at the old source origin. `false` — at least one
internal link still points at the source.

An item with no internal links MUST be reported `true` (vacuously). When `false`,
producers SHOULD include `asset_counts` (§5).

## 5. Optional extension fields

The core is six fields. The following optional fields are RECOMMENDED so tools can share
richer data without breaking conformance. Consumers MUST ignore any field they do not
recognize (§8).

| Field | Type | Applies to | Description |
| :--- | :--- | :--- | :--- |
| `redirect_target` | string | `redirected` | Final absolute URL the source resolves to after all hops. |
| `reason` | string | `quarantined`, `failed`, `excluded` | Human-readable cause (e.g. "missing featured image", "draft"). |
| `checksum` | string | any | Content checksum recorded on extract (portage: sha256, 12 hex chars) so a consumer can detect content drift. |
| `asset_counts` | object | any | Counts behind the booleans: `images_total`, `images_rehosted`, `images_failed`, `links_total`, `links_rewritten`, `links_failed`. Non-negative integers. |

## 6. Validation rules

Conforming producers MUST ensure:

1. `source_url` is unique across all records (one record per source URL; duplicates are a
   producer bug).
2. `destination_path` starts with `/`; it MAY include a query string and MUST NOT include a
   fragment.
3. `status` is drawn from the closed vocabulary (§4.3).
4. `redirect_target` and `asset_counts` only appear where the status allows (§5).
5. A `redirected` record SHOULD have a `redirect_target`; a `migrated` record SHOULD NOT.
6. `destination_path` is `null` for `quarantined` and `excluded`; SHOULD be non-null for
   `migrated` and `redirected`.

Consumers SHOULD flag two records whose `destination_path` is identical and non-null as a
potential **content collision** (two sources landing on one path).

## 7. Normative JSON Schema

The machine-readable schema is the canonical artifact and lives at
[`schema/migration-report.schema.json`](../schema/migration-report.schema.json)
(JSON Schema draft-07). Both producers and consumers SHOULD validate against it. A
summary is reproduced in Appendix A.

## 8. Conformance

**A conforming producer MUST:**

- write `migration-report.json` to the root of the migration output directory,
- validate its output against the JSON Schema before writing (or fail loudly),
- fill all six required record fields,
- use the closed `status` vocabulary and the normalization rules in §4.2,
- emit `version: "1.0"`.

**A conforming consumer MUST:**

- reject documents with an unknown `version` (clear error, no silent skip),
- ignore unknown fields at any level,
- resolve `destination_path` against `destination_base_url` as a simple string join
  (`base + path`), per RFC 3986,
- tolerate missing optional fields.

**A conforming consumer SHOULD:**

- flag duplicate non-null `destination_path` values as collisions,
- warn when `asset_counts` contradict a boolean (e.g. `images_failed > 0` with
  `images_rehosted: true`),
- emit a per-status verification summary rather than a bare list.

## 9. Relationship to the legacy portage report

Earlier portage CLI versions wrote `migration-report.json` in a camelCase, summary-oriented
shape (`version: "2"`, `schema: "linkcanary"`). That shape is **superseded** by this
standard; portage now emits this standard (Appendix B). Consumers MAY retain read
support for the legacy shape, detected by `version === "2"`.

The `portage.manifest.json` integrity ledger is a separate file and is unchanged by this
standard.

## 10. Worked example

A Squarespace → Astro migration with four representative records:

```json
{
  "version": "1.0",
  "generated_by": "portage@0.9.2",
  "generated_at": "2026-08-08T19:04:12Z",
  "destination_base_url": "https://example.com",
  "destination_platform": "astro",
  "records": [
    {
      "source_platform": "squarespace",
      "source_url": "https://example.squarespace.com/blog/storytelling-copywriter",
      "destination_path": "/blog/storytelling-copywriter/",
      "status": "migrated",
      "images_rehosted": true,
      "links_rewritten": true,
      "checksum": "9f2c41ab0d7e",
      "asset_counts": {
        "images_total": 3,
        "images_rehosted": 3,
        "images_failed": 0,
        "links_total": 12,
        "links_rewritten": 12,
        "links_failed": 0
      }
    },
    {
      "source_platform": "squarespace",
      "source_url": "https://example.squarespace.com/blog/nonprofit-registration",
      "destination_path": "/blog/nonprofit-registration/",
      "status": "migrated",
      "images_rehosted": true,
      "links_rewritten": false,
      "asset_counts": {
        "links_total": 8,
        "links_rewritten": 6,
        "links_failed": 2
      }
    },
    {
      "source_platform": "squarespace",
      "source_url": "https://example.squarespace.com/about/team",
      "destination_path": "/about/",
      "status": "redirected",
      "redirect_target": "https://example.com/about/",
      "images_rehosted": true,
      "links_rewritten": true
    },
    {
      "source_platform": "squarespace",
      "source_url": "https://example.squarespace.com/blog/2021/01/draft-post",
      "destination_path": null,
      "status": "quarantined",
      "reason": "unfinished draft; excluded pending editorial decision",
      "images_rehosted": false,
      "links_rewritten": false
    }
  ]
}
```

## 11. LinkCanary ingestion contract (informative)

LinkCanary (or any auditor) verifies a migration in four steps:

1. **Load.** Read `migration-report.json`, validate against the JSON Schema. Resolve each
   `destination_path` against `destination_base_url` to build the set of expected live URLs.
2. **Crawl.** Crawl the destination site as usual (sitemap seed, plus every expected URL as
   an explicit seed so *missing* destinations are proven missing, not just uncrawled).
   Record the observed status of every source and destination URL.
3. **Cross-reference.** For each record, compare observed vs expected:

   | Record status | Verified when | Reported as |
   | :--- | :--- | :--- |
   | `migrated` | destination 2xx | `verified` |
   | `migrated` | destination 4xx/5xx | `missing` |
   | `redirected` | source 3xx → 2xx chain, target matches `redirect_target` | `verified` |
   | `redirected` | source does not redirect as declared | `redirect_missing` |
   | `quarantined` / `excluded` | source is 4xx/5xx | `verified` |
   | `quarantined` / `excluded` | source still 2xx | `unexpected_live` |
   | any | two records share a destination path | `collision` |
   | `migrated` | destination 2xx but checksum (if provided) differs from extracted content | `content_mismatch` |

4. **Report.** Standard LinkCanary issue report (CSV/HTML) for everything that is not
   `verified`, plus a migration-verification summary: per-status counts of
   verified / missing / mismatched, so the answer to "did the migration land?" is one glance.

Redirects that are deployment concerns (http→https, www→apex, trailing-slash
normalization, host moves) are **not** migration records — LinkCanary's own crawl catches
those. The report covers content-level dispositions only.

---

## Appendix A — Schema summary

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://portage.dev/schemas/migration-report.schema.json",
  "type": "object",
  "required": ["version", "generated_by", "generated_at", "destination_base_url", "destination_platform", "records"],
  "properties": {
    "version": { "const": "1.0" },
    "generated_by": { "type": "string", "minLength": 1 },
    "generated_at": { "type": "string", "format": "date-time" },
    "destination_base_url": { "type": "string", "pattern": "^https?://[^/]+(/[^/]+)*$" },
    "destination_platform": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "records": {
      "type": "array",
      "items": { "$ref": "#/definitions/record" }
    }
  },
  "additionalProperties": true,
  "definitions": {
    "record": {
      "type": "object",
      "required": ["source_platform", "source_url", "destination_path", "status", "images_rehosted", "links_rewritten"],
      "properties": {
        "source_platform": { "type": "string", "pattern": "^[a-z0-9-]+$" },
        "source_url": { "type": "string", "format": "uri" },
        "destination_path": { "type": ["string", "null"], "pattern": "^/" },
        "status": { "enum": ["migrated", "redirected", "quarantined", "failed", "excluded"] },
        "images_rehosted": { "type": "boolean" },
        "links_rewritten": { "type": "boolean" },
        "redirect_target": { "type": "string", "format": "uri" },
        "reason": { "type": "string" },
        "checksum": { "type": "string" },
        "asset_counts": {
          "type": "object",
          "properties": {
            "images_total": { "type": "integer", "minimum": 0 },
            "images_rehosted": { "type": "integer", "minimum": 0 },
            "images_failed": { "type": "integer", "minimum": 0 },
            "links_total": { "type": "integer", "minimum": 0 },
            "links_rewritten": { "type": "integer", "minimum": 0 },
            "links_failed": { "type": "integer", "minimum": 0 }
          }
        }
      },
      "additionalProperties": true
    }
  }
}
```

## Appendix B — Implementation status

### Portage CLI (implemented)

The CLI emits the v1.0 standard. Change points, as built:

1. **`cli/src/report.ts`** — v1.0 shapes, Zod validation (mirror of the JSON Schema), `buildMigrationRecords()` (item → record), `validateMigrationReport()` (thrown by `writeMigrationReport` before writing), and an adapted Markdown report. The legacy camelCase v2 generator is removed.
2. **`cli/src/index.ts`** — the `load` command assembles records from per-item data: export platforms (Squarespace/Substack/Ghost) read real source URLs from their sidecars; filesystem platforms (Gatsby/Jekyll/Next) get items from the collection writer. Status mapping: drafts → `excluded`, Ghost Lexical content → `quarantined`, everything else → `migrated`. `images_rehosted` is false only when an item's body references a CDN image that failed to download. `--base-url` overrides the destination base URL (default: the `astro.config.mjs` site value, else `https://example.com`).
3. **`cli/src/astro-writer.ts`** — `writeCollections` returns per-item data; `resolveSiteUrl()`/`resolveSiteSettings()` are shared by the Astro config writer and the report.
4. **Tests** — `cli/tests/core.test.ts` covers record building, status classification, image-failure flagging, schema validation, and file writing; the whole suite validates the written file re-reads clean.

Fidelity notes: `links_rewritten` is always true today (the pipeline records rewrites it performs, not links it fails to rewrite); `redirected` records are not yet emitted (redirect generation is a placeholder); `asset_counts` is not emitted. All are non-breaking optional/extension surfaces of the standard.

### LinkCanary side (implemented)

`linkcheck --verify-migration <file>` (optionally `--site <base-url>` to verify a
staging/preview build) implements §11: load + validate the report, check the exact
expectation set (destinations, sources, gone-records), cross-reference, emit
`migration-verification.csv`, and exit 0 only when every record verifies. Outcomes:
`verified`, `missing`, `redirect_missing`, `unexpected_live`, `collision`, `review`.
Implementation: `link_checker/migration_verifier.py` in the LinkCanary repo.

## Appendix C — Companion tooling (informative)

The following tools consume the standard directly:

- **Portage `slug-audit`** — reads `migration-report.json`, compares pre-migration
  slugs (`source_url`) against post-migration paths (`destination_path`), and emits
  redirect rules as Nginx `location` blocks, Caddy `redir` directives, or a
  Netlify/Cloudflare Pages `_redirects` file. Records whose URL did not change are
  skipped; `excluded`/`quarantined` records can be emitted as `410 Gone` with
  `--gone`; `failed` records are never emitted (they need review, not a redirect).
- **LinkCanary** — crawls the destination and cross-references every record against
  what resolves (the verification contract in §11).

Suggested workflow after any migration: `portage load` → `portage slug-audit`
(with `--gone` after quarantined items are resolved) → deploy redirects →
`linkcanary --migration-report migration-report.json` to prove the crossing landed.

## Appendix D — Future extensions (non-normative)

- Per-record error details / stack traces for `failed`.
- Batch verification timestamps (when each URL was last confirmed live).
- Signed reports (producer keyed checksums) for supply-chain trust in agency handoffs.
- A `redirects[]` top-level array for pure content-level redirect rules that have no
  corresponding source record (currently out of scope, §11).
