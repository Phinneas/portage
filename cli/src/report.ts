/**
 * Shared migration report generator. Produces both JSON and Markdown
 * reports after a migration completes. Part of the portage-core shared pipeline.
 *
 * JSON report: migration-report.json (machine-readable, LinkCanary-compatible)
 * Markdown report: migration-report.md (human-readable)
 *
 * LinkCanary-compatible schema: URL-level detail for redirect auditing,
 * per-stage pass/fail rates, quarantined posts, and image rehost tracking.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateHandoff } from './creatives.js';

// ── Types ───────────────────────────────────────────────────────────────

/** Per-stage extraction counts and pass rates */
export interface StageStats {
  total: number;
  passed: number;
  failed: number;
  passRate: number; // 0-1
}

/** A post that was quarantined (excluded from output) with reason */
export interface QuarantinedPost {
  slug: string;
  title: string;
  originalUrl?: string;
  reason: string;
  stage: 'extract' | 'transform' | 'load';
}

/** Per-image rehost status */
export interface ImageRehost {
  originalUrl: string;
  localPath: string;
  status: 'downloaded' | 'skipped' | 'failed';
  error?: string;
}

/** URL-level redirect entry (LinkCanary-compatible) */
export interface RedirectEntry {
  source: string;
  target: string;
  statusCode: number;
  type: '301' | '302' | 'meta' | 'none';
}

export interface MigrationReport {
  version: '2';
  schema: 'linkcanary';
  source: {
    platform: string;
    exportFile?: string;
    url?: string;
  };
  destination: {
    platform: string;
    method: string;
    url?: string;
  };
  stages: {
    extract: StageStats;
    transform: StageStats;
    load: StageStats;
  };
  summary: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    redirects: number;
    skippedDrafts: number;
  };
  images: {
    total: number;
    rehosted: number;
    failed: number;
    skipped: number;
    details: ImageRehost[];
  };
  quarantined: QuarantinedPost[];
  redirectsList: RedirectEntry[];
  output: {
    seedScript?: string;
    config?: string;
    mediaDir?: string;
    envFile?: string;
  };
  handoff: {
    templateSlug: string | null;
    templateName: string | null;
    templateUrl: string | null;
    pricing: 'free' | 'paid' | null;
  };
  completedAt: string;
}

/** Build a StageStats from counts */
export function stageStats(total: number, passed: number): StageStats {
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    passRate: total > 0 ? Math.round((passed / total) * 1000) / 1000 : 1,
  };
}

// ── JSON Report Generation ────────────────────────────────────────────────

export interface ReportInput {
  sourcePlatform: string;
  destinationPlatform: string;
  method: string;
  counts: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    redirects: number;
    skippedDrafts: number;
  };
  stages: {
    extract: StageStats;
    transform: StageStats;
    load: StageStats;
  };
  imageDetails: ImageRehost[];
  quarantined: QuarantinedPost[];
  redirectsList: RedirectEntry[];
  output: {
    seedScript?: string;
    config?: string;
    mediaDir?: string;
    envFile?: string;
  };
  exportFile?: string;
  sourceUrl?: string;
  destinationUrl?: string;
}

export function generateMigrationReport(input: ReportInput): MigrationReport {
  const handoff = generateHandoff(input.sourcePlatform, input.destinationPlatform);

  const rehosted = input.imageDetails.filter((i) => i.status === 'downloaded').length;
  const failed = input.imageDetails.filter((i) => i.status === 'failed').length;
  const skipped = input.imageDetails.filter((i) => i.status === 'skipped').length;

  return {
    version: '2',
    schema: 'linkcanary',
    source: {
      platform: input.sourcePlatform,
      exportFile: input.exportFile,
      url: input.sourceUrl,
    },
    destination: {
      platform: input.destinationPlatform,
      method: input.method,
      url: input.destinationUrl,
    },
    stages: input.stages,
    summary: input.counts,
    images: {
      total: input.imageDetails.length,
      rehosted,
      failed,
      skipped,
      details: input.imageDetails,
    },
    quarantined: input.quarantined,
    redirectsList: input.redirectsList,
    output: input.output,
    handoff: {
      templateSlug: handoff.template?.slug || null,
      templateName: handoff.template?.name || null,
      templateUrl: handoff.template?.url || null,
      pricing: handoff.template?.pricing || null,
    },
    completedAt: new Date().toISOString(),
  };
}

// ── Markdown Report Generation ────────────────────────────────────────────

export function generateMarkdownReport(report: MigrationReport): string {
  const lines: string[] = [];

  lines.push(`# Migration Report`);
  lines.push('');
  lines.push(`**Route:** ${report.source.platform} → ${report.destination.platform}`);
  lines.push(`**Method:** ${report.destination.method}`);
  lines.push(`**Completed:** ${report.completedAt}`);
  lines.push('');

  // Per-stage pass rates
  lines.push(`## Pass Rates`);
  lines.push('');
  lines.push(`| Stage | Total | Passed | Failed | Pass Rate |`);
  lines.push(`|-------|-------|--------|--------|-----------|`);
  for (const [name, stats] of Object.entries(report.stages)) {
    const pct = (stats.passRate * 100).toFixed(1) + '%';
    lines.push(`| ${name} | ${stats.total} | ${stats.passed} | ${stats.failed} | ${pct} |`);
  }
  lines.push('');

  // Summary counts
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Posts | ${report.summary.posts} |`);
  lines.push(`| Pages | ${report.summary.pages} |`);
  lines.push(`| Tags | ${report.summary.tags} |`);
  lines.push(`| Authors | ${report.summary.authors} |`);
  lines.push(`| Images | ${report.images.total} |`);
  lines.push(`| Images rehosted | ${report.images.rehosted} |`);
  if (report.images.failed > 0) {
    lines.push(`| Images failed | ${report.images.failed} |`);
  }
  if (report.images.skipped > 0) {
    lines.push(`| Images skipped | ${report.images.skipped} |`);
  }
  lines.push(`| Redirects | ${report.summary.redirects} |`);
  if (report.summary.skippedDrafts > 0) {
    lines.push(`| Skipped drafts | ${report.summary.skippedDrafts} |`);
  }
  lines.push('');

  // Quarantined posts
  if (report.quarantined.length > 0) {
    lines.push(`## Quarantined Posts (${report.quarantined.length})`);
    lines.push('');
    lines.push(`| Slug | Title | Stage | Reason |`);
    lines.push(`|------|-------|-------|--------|`);
    for (const q of report.quarantined) {
      lines.push(`| ${q.slug} | ${q.title} | ${q.stage} | ${q.reason} |`);
    }
    lines.push('');
  }

  // Image rehost summary
  if (report.images.details.length > 0) {
    const failedImages = report.images.details.filter((i) => i.status === 'failed');
    if (failedImages.length > 0) {
      lines.push(`## Failed Image Rehosts (${failedImages.length})`);
      lines.push('');
      lines.push(`| Original URL | Error |`);
      lines.push(`|-------------|-------|`);
      for (const img of failedImages) {
        lines.push(`| ${img.originalUrl} | ${img.error || 'unknown'} |`);
      }
      lines.push('');
    }
  }

  // Redirect list
  if (report.redirectsList.length > 0) {
    lines.push(`## Redirects (${report.redirectsList.length})`);
    lines.push('');
    lines.push(`| Source | Target | Type |`);
    lines.push(`|--------|--------|------|`);
    for (const r of report.redirectsList) {
      lines.push(`| ${r.source} | ${r.target} | ${r.type} |`);
    }
    lines.push('');
  }

  // Output paths
  if (report.output.seedScript || report.output.config) {
    lines.push(`## Output`);
    lines.push('');
    if (report.output.seedScript) lines.push(`- Seed script: \`${report.output.seedScript}\``);
    if (report.output.config) lines.push(`- Config: \`${report.output.config}\``);
    if (report.output.mediaDir) lines.push(`- Media: \`${report.output.mediaDir}\``);
    if (report.output.envFile) lines.push(`- Environment: \`${report.output.envFile}\``);
    lines.push('');
  }

  // Handoff
  if (report.handoff.templateSlug) {
    lines.push(`## Next Step`);
    lines.push('');
    const pricing = report.handoff.pricing === 'free' ? 'free' : 'available';
    lines.push(`The **${report.handoff.templateName}** template is ${pricing} from Salish Sea Creatives.`);
    lines.push(`Pre-wired for your new CMS. → ${report.handoff.templateUrl}`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ── File Writers ──────────────────────────────────────────────────────────

export function writeMigrationReport(
  report: MigrationReport,
  targetDir: string,
): string {
  const path = resolve(targetDir, 'migration-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return path;
}

export function writeMarkdownReport(
  report: MigrationReport,
  targetDir: string,
): string {
  const path = resolve(targetDir, 'migration-report.md');
  writeFileSync(path, generateMarkdownReport(report), 'utf-8');
  return path;
}

// ── Backward compatibility ────────────────────────────────────────────────
// Old function signature used by existing callers. Wraps the new API.

export interface LegacyCounts {
  posts: number;
  pages: number;
  tags: number;
  authors: number;
  images: number;
  imagesDownloaded: number;
  imagesFailed: number;
  redirects: number;
  skippedDrafts: number;
}

/**
 * @deprecated Use generateMigrationReport(input: ReportInput) instead.
 * Legacy wrapper for backward compatibility.
 */
export function generateLegacyMigrationReport(
  sourcePlatform: string,
  destinationPlatform: string,
  method: string,
  counts: LegacyCounts,
  output: {
    seedScript?: string;
    config?: string;
    mediaDir?: string;
    envFile?: string;
  },
  exportFile?: string,
): MigrationReport {
  const totalItems = counts.posts + counts.pages;
  const extractPassed = totalItems;
  const transformPassed = totalItems;
  const loadPassed = totalItems - counts.skippedDrafts;

  const imageDetails: ImageRehost[] = [];
  // We don't have per-image detail from the legacy path, just counts
  for (let i = 0; i < counts.imagesDownloaded; i++) {
    imageDetails.push({ originalUrl: '', localPath: '', status: 'downloaded' });
  }
  for (let i = 0; i < counts.imagesFailed; i++) {
    imageDetails.push({ originalUrl: '', localPath: '', status: 'failed', error: 'download failed' });
  }
  const skippedImages = counts.images - counts.imagesDownloaded - counts.imagesFailed;
  for (let i = 0; i < skippedImages; i++) {
    imageDetails.push({ originalUrl: '', localPath: '', status: 'skipped' });
  }

  return generateMigrationReport({
    sourcePlatform,
    destinationPlatform,
    method,
    counts: {
      posts: counts.posts,
      pages: counts.pages,
      tags: counts.tags,
      authors: counts.authors,
      images: counts.images,
      redirects: counts.redirects,
      skippedDrafts: counts.skippedDrafts,
    },
    stages: {
      extract: stageStats(totalItems, extractPassed),
      transform: stageStats(totalItems, transformPassed),
      load: stageStats(totalItems, loadPassed),
    },
    imageDetails,
    quarantined: [],
    redirectsList: [],
    output,
    exportFile,
  });
}
