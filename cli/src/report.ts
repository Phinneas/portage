/**
 * Shared migration report generator. Produces both JSON and Markdown
 * reports after a migration completes. Extracted from creatives.ts to
 * be part of the portage-core shared pipeline.
 *
 * JSON report: migration-report.json (machine-readable)
 * Markdown report: migration-report.md (human-readable)
 *
 * This is part of the portage-core shared pipeline.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateHandoff } from './creatives.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface MigrationReport {
  version: '1';
  source: {
    platform: string;
    exportFile?: string;
  };
  destination: {
    platform: string;
    method: string;
  };
  summary: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    imagesDownloaded: number;
    imagesFailed: number;
    redirects: number;
    skippedDrafts: number;
  };
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

// ── JSON Report Generation ────────────────────────────────────────────────

export function generateMigrationReport(
  sourcePlatform: string,
  destinationPlatform: string,
  method: string,
  counts: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    imagesDownloaded: number;
    imagesFailed: number;
    redirects: number;
    skippedDrafts: number;
  },
  output: {
    seedScript?: string;
    config?: string;
    mediaDir?: string;
    envFile?: string;
  },
  exportFile?: string,
): MigrationReport {
  const handoff = generateHandoff(sourcePlatform, destinationPlatform);

  return {
    version: '1',
    source: {
      platform: sourcePlatform,
      exportFile,
    },
    destination: {
      platform: destinationPlatform,
      method,
    },
    summary: counts,
    output,
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

  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Posts | ${report.summary.posts} |`);
  lines.push(`| Pages | ${report.summary.pages} |`);
  lines.push(`| Tags | ${report.summary.tags} |`);
  lines.push(`| Authors | ${report.summary.authors} |`);
  lines.push(`| Images | ${report.summary.images} |`);
  lines.push(`| Images downloaded | ${report.summary.imagesDownloaded} |`);
  if (report.summary.imagesFailed > 0) {
    lines.push(`| Images failed | ${report.summary.imagesFailed} |`);
  }
  lines.push(`| Redirects | ${report.summary.redirects} |`);
  if (report.summary.skippedDrafts > 0) {
    lines.push(`| Skipped drafts | ${report.summary.skippedDrafts} |`);
  }
  lines.push('');

  if (report.output.seedScript || report.output.config) {
    lines.push(`## Output`);
    lines.push('');
    if (report.output.seedScript) lines.push(`- Seed script: \`${report.output.seedScript}\``);
    if (report.output.config) lines.push(`- Config: \`${report.output.config}\``);
    if (report.output.mediaDir) lines.push(`- Media: \`${report.output.mediaDir}\``);
    if (report.output.envFile) lines.push(`- Environment: \`${report.output.envFile}\``);
    lines.push('');
  }

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
