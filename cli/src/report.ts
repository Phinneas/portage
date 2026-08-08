/**
 * Shared migration report generator. Produces both JSON and Markdown
 * reports after a migration completes. Part of the portage-core shared pipeline.
 *
 * JSON report: migration-report.json (machine-readable, LinkCanary-compatible)
 * Markdown report: migration-report.md (human-readable)
 *
 * The migration-report.json output shape is defined by the open
 * Migration Report Schema v1.0 — see cli/docs/migration-report-schema.md
 * (normative spec) and cli/schema/migration-report.schema.json (machine schema).
 *
 * Core contract: one record per migrated source URL with the six required
 * fields (source_platform, source_url, destination_path, status,
 * images_rehosted, links_rewritten). Auditors (LinkCanary) ingest the file to
 * verify that migrated URLs resolve on the destination site.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// ── Schema version ────────────────────────────────────────────────────────

export const REPORT_SCHEMA_VERSION = '1.0' as const;
export const REPORT_GENERATED_BY = 'portage@0.1.0'; // keep in sync with package.json

// ── Zod schema (mirror of cli/schema/migration-report.schema.json) ────────

const platformId = z.string().regex(/^[a-z0-9-]+$/, 'platform identifiers are [a-z0-9-]');
const absoluteUrl = z.string().url('must be an absolute URL');
const absolutePath = z.string().startsWith('/').nullable();

export const MigrationRecordSchema = z
  .object({
    source_platform: platformId,
    source_url: absoluteUrl,
    destination_path: absolutePath,
    status: z.enum(['migrated', 'redirected', 'quarantined', 'failed', 'excluded']),
    images_rehosted: z.boolean(),
    links_rewritten: z.boolean(),
    // Optional extension fields (consumers MUST ignore unknown fields)
    redirect_target: absoluteUrl.optional(),
    reason: z.string().optional(),
    checksum: z.string().optional(),
    asset_counts: z
      .object({
        images_total: z.number().int().min(0).optional(),
        images_rehosted: z.number().int().min(0).optional(),
        images_failed: z.number().int().min(0).optional(),
        links_total: z.number().int().min(0).optional(),
        links_rewritten: z.number().int().min(0).optional(),
        links_failed: z.number().int().min(0).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const MigrationReportSchema = z
  .object({
    version: z.literal(REPORT_SCHEMA_VERSION),
    generated_by: z.string().min(1),
    generated_at: z.string().datetime({ offset: true }),
    destination_base_url: z.string().regex(/^https?:\/\/[^/]+(\/[^/]+)*$/),
    destination_platform: platformId,
    records: z.array(MigrationRecordSchema),
  })
  .passthrough();

export type MigrationStatus = 'migrated' | 'redirected' | 'quarantined' | 'failed' | 'excluded';
export type MigrationRecord = z.infer<typeof MigrationRecordSchema>;
export type MigrationReport = z.infer<typeof MigrationReportSchema>;

/** Validates a report against the v1.0 standard; throws on the first violation. */
export function validateMigrationReport(report: MigrationReport): void {
  MigrationReportSchema.parse(report);
}

// ── Per-item migration data (produced by the pipeline) ────────────────────

/**
 * One content item as it exists at load time. Converted to a spec record by
 * buildMigrationRecords(). sourceUrl is the item's URL on the source site;
 * where the platform does not record one, buildMigrationRecords() derives it
 * from sourceSiteUrl + the item path.
 */
export interface MigrationItem {
  sourceUrl: string | null;
  slug: string;
  collection: string; // blog | pages | podcast | threads | custom collection
  draft: boolean;
  /** Present for filesystem platforms; used to correlate transform rewrites. */
  relativePath?: string;
  /** Raw body HTML for export platforms; used to detect un-rehosted images. */
  contentHtml?: string;
  checksum?: string;
  /** Ghost posts whose body was Lexical (HTML fallback used) → quarantined. */
  lexical?: boolean;
}

export interface ReportBuildContext {
  sourcePlatform: string;
  /** Source site origin (from source config) for deriving source URLs. */
  sourceSiteUrl: string;
  /** Absolute URLs of CDN images that failed to download during load. */
  failedImageUrls: Set<string>;
}

function referencesFailedImage(contentHtml: string, failedImageUrls: Set<string>): boolean {
  if (failedImageUrls.size === 0) return false;
  for (const url of failedImageUrls) {
    if (contentHtml.includes(url)) return true;
  }
  return false;
}

/**
 * Converts per-item pipeline data into spec records (§4 of the schema spec).
 *
 * Fidelity notes (documented best-effort):
 * - `links_rewritten`: the pipeline records rewrites it *performs*, not links it
 *   fails to rewrite, so every carried item is reported true (vacuous-true when
 *   no links were detected). Future link-audit data can flip this to false.
 * - `images_rehosted`: false only when the item's raw body references an image
 *   URL that failed to download during load (export platforms). Filesystem
 *   platforms have no per-item image provenance, so they report vacuous true.
 */
export function buildMigrationRecords(items: MigrationItem[], ctx: ReportBuildContext): MigrationRecord[] {
  return items.map((item) => {
    const collection = item.collection || 'blog';
    const slug = item.slug || 'untitled';
    const path = `/${collection}/${slug}/`;

    let sourceUrl = item.sourceUrl;
    if (!sourceUrl) {
      // Filesystem platforms: the old site served the item at the same path
      // convention it now serves at the destination (same-path migration).
      sourceUrl = `${ctx.sourceSiteUrl}${path}`;
    }

    let status: MigrationStatus = 'migrated';
    if (item.lexical) status = 'quarantined';
    else if (item.draft) status = 'excluded';

    const imagesRehosted = item.contentHtml ? !referencesFailedImage(item.contentHtml, ctx.failedImageUrls) : true;

    const record: MigrationRecord = {
      source_platform: ctx.sourcePlatform,
      source_url: sourceUrl,
      destination_path: path,
      status,
      images_rehosted: imagesRehosted,
      links_rewritten: true, // see fidelity note above
    };
    if (item.checksum) record.checksum = item.checksum;
    if (status !== 'migrated') {
      record.reason = item.lexical
        ? 'Lexical editor content — HTML fallback used; review for content fidelity'
        : 'Draft status — excluded from published output';
    }
    return record;
  });
}

// ── JSON Report Generation ────────────────────────────────────────────────

export interface ReportInput {
  destinationBaseUrl: string;
  destinationPlatform: string;
  records: MigrationRecord[];
  generatedBy?: string;
}

export function generateMigrationReport(input: ReportInput): MigrationReport {
  return {
    version: REPORT_SCHEMA_VERSION,
    generated_by: input.generatedBy ?? REPORT_GENERATED_BY,
    generated_at: new Date().toISOString(),
    destination_base_url: input.destinationBaseUrl,
    destination_platform: input.destinationPlatform,
    records: input.records,
  };
}

// ── Markdown Report Generation ────────────────────────────────────────────

export function generateMarkdownReport(report: MigrationReport): string {
  const lines: string[] = [];

  const sourcePlatform = report.records[0]?.source_platform ?? 'unknown';
  const statusCounts = new Map<MigrationStatus, number>();
  const notRewritten = new Map<string, number>();
  const notRehosted = new Map<string, number>();

  for (const r of report.records) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    if (!r.images_rehosted) notRehosted.set(r.source_url, 1);
    if (!r.links_rewritten) notRewritten.set(r.source_url, 1);
  }

  lines.push(`# Migration Report`);
  lines.push('');
  lines.push(`**Route:** ${sourcePlatform} → ${report.destination_platform}`);
  lines.push(`**Destination base URL:** ${report.destination_base_url}`);
  lines.push(`**Generated:** ${report.generated_at} by ${report.generated_by}`);
  lines.push(`**Schema:** migration-report v${report.version}`);
  lines.push('');

  lines.push(`## Status Summary (${report.records.length} records)`);
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  for (const status of ['migrated', 'redirected', 'quarantined', 'failed', 'excluded'] as MigrationStatus[]) {
    const count = statusCounts.get(status) ?? 0;
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push('');

  if (notRehosted.size > 0) {
    lines.push(`## Images not rehosted (${notRehosted.size})`);
    lines.push('');
    lines.push(`| Source URL |`);
    lines.push(`|-----------|`);
    for (const url of notRehosted.keys()) lines.push(`| ${url} |`);
    lines.push('');
  }

  if (notRewritten.size > 0) {
    lines.push(`## Links not rewritten (${notRewritten.size})`);
    lines.push('');
    lines.push(`| Source URL |`);
    lines.push(`|-----------|`);
    for (const url of notRewritten.keys()) lines.push(`| ${url} |`);
    lines.push('');
  }

  const quarantined = report.records.filter((r) => r.status === 'quarantined' || r.status === 'failed');
  if (quarantined.length > 0) {
    lines.push(`## Needs Review (${quarantined.length})`);
    lines.push('');
    lines.push(`| Status | Source URL | Reason |`);
    lines.push(`|--------|-----------|--------|`);
    for (const r of quarantined) lines.push(`| ${r.status} | ${r.source_url} | ${r.reason || '—'} |`);
    lines.push('');
  }

  lines.push(`## Records (${report.records.length})`);
  lines.push('');
  if (report.records.length > 0) {
    lines.push(`| Source URL | Destination | Status | Imgs | Links |`);
    lines.push(`|-----------|-------------|--------|------|-------|`);
    for (const r of report.records) {
      const dest = r.destination_path ?? '—';
      lines.push(`| ${r.source_url} | ${dest} | ${r.status} | ${r.images_rehosted ? '✓' : '✗'} | ${r.links_rewritten ? '✓' : '✗'} |`);
    }
    lines.push('');
  }

  lines.push(`_Verify with LinkCanary: crawl ${report.destination_base_url} and cross-reference these records._`);
  lines.push('');

  return lines.join('\n') + '\n';
}

// ── File Writers ──────────────────────────────────────────────────────────

export function writeMigrationReport(report: MigrationReport, targetDir: string): string {
  // Conformance: validate against the v1.0 standard before writing (spec §8).
  validateMigrationReport(report);
  const path = resolve(targetDir, 'migration-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return path;
}

export function writeMarkdownReport(report: MigrationReport, targetDir: string): string {
  const path = resolve(targetDir, 'migration-report.md');
  writeFileSync(path, generateMarkdownReport(report), 'utf-8');
  return path;
}
