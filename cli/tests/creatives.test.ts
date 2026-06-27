import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import {
  TEMPLATES,
  findTemplate,
  generateHandoff,
  generateMigrationReport,
  writeMigrationReport,
} from '../src/creatives.js';
import type { CreativesTemplate, MigrationReport } from '../src/creatives.js';

// ── Template Registry ────────────────────────────────────────────────────

describe('TEMPLATES', () => {
  it('has at least 4 templates registered', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
  });

  it('each template has a slug, name, url, destination, and sourcePlatforms', () => {
    for (const t of TEMPLATES) {
      expect(t.slug).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.url).toContain('salishsea');
      expect(t.destination).toBeTruthy();
      expect(Array.isArray(t.sourcePlatforms)).toBe(true);
    }
  });

  it('includes astro-payload template', () => {
    const t = TEMPLATES.find((t) => t.slug === 'astro-payload');
    expect(t).toBeDefined();
    expect(t!.destination).toBe('payload');
    expect(t!.sourcePlatforms).toContain('ghost');
    expect(t!.sourcePlatforms).toContain('wordpress');
  });

  it('includes astro-sanity template', () => {
    const t = TEMPLATES.find((t) => t.slug === 'astro-sanity');
    expect(t).toBeDefined();
    expect(t!.destination).toBe('sanity');
  });

  it('includes astro-keystatic template', () => {
    const t = TEMPLATES.find((t) => t.slug === 'astro-keystatic');
    expect(t).toBeDefined();
    expect(t!.destination).toBe('keystatic');
    expect(t!.pricing).toBe('free');
  });

  it('includes astro-blog template for generic Astro destinations', () => {
    const t = TEMPLATES.find((t) => t.slug === 'astro-blog');
    expect(t).toBeDefined();
    expect(t!.destination).toBe('astro');
  });
});

// ── Template Matching ────────────────────────────────────────────────────

describe('findTemplate', () => {
  it('matches ghost → payload to astro-payload', () => {
    const t = findTemplate('ghost', 'payload');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-payload');
  });

  it('matches wordpress → payload to astro-payload', () => {
    const t = findTemplate('wordpress', 'payload');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-payload');
  });

  it('matches contentful → sanity to astro-sanity', () => {
    const t = findTemplate('contentful', 'sanity');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-sanity');
  });

  it('matches storyblok → keystatic to astro-keystatic', () => {
    const t = findTemplate('storyblok', 'keystatic');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-keystatic');
  });

  it('matches gatsby → astro to astro-blog', () => {
    const t = findTemplate('gatsby', 'astro');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-blog');
  });

  it('matches jekyll → astro to astro-blog', () => {
    const t = findTemplate('jekyll', 'astro');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-blog');
  });

  it('matches next → astro to astro-blog', () => {
    const t = findTemplate('next', 'astro');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-blog');
  });

  it('matches substack → astro to astro-blog', () => {
    const t = findTemplate('substack', 'astro');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-blog');
  });

  it('matches squarespace → payload (destination-agnostic match)', () => {
    const t = findTemplate('squarespace', 'payload');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-payload');
  });

  it('returns null for unknown destination', () => {
    const t = findTemplate('ghost', 'strapi');
    expect(t).toBeNull();
  });

  it('returns generic blog template for Astro destination even with unknown source', () => {
    const t = findTemplate('hugo', 'astro');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('astro-blog');
  });
});

// ── Handoff Link Generation ──────────────────────────────────────────────

describe('generateHandoff', () => {
  it('generates a handoff for ghost → payload', () => {
    const h = generateHandoff('ghost', 'payload');
    expect(h.template).not.toBeNull();
    expect(h.template!.slug).toBe('astro-payload');
    expect(h.link).toContain('astro-payload');
    expect(h.message).toContain('Astro + Payload');
    expect(h.message).toContain('salishsea');
  });

  it('generates a free-tier handoff for storyblok → keystatic', () => {
    const h = generateHandoff('storyblok', 'keystatic');
    expect(h.template).not.toBeNull();
    expect(h.template!.pricing).toBe('free');
    expect(h.message).toContain('free');
  });

  it('generates a paid-tier handoff for ghost → payload', () => {
    const h = generateHandoff('ghost', 'payload');
    expect(h.template!.pricing).toBe('paid');
    expect(h.message).toContain('available');
  });

  it('generates handoff for Astro-only routes', () => {
    const h = generateHandoff('gatsby', 'astro');
    expect(h.template).not.toBeNull();
    expect(h.template!.slug).toBe('astro-blog');
    expect(h.link).toContain('astro-blog');
  });

  it('returns null template for unmatched destination', () => {
    const h = generateHandoff('ghost', 'strapi');
    expect(h.template).toBeNull();
    expect(h.link).toBe('');
    expect(h.message).toContain('No paired template');
  });
});

// ── Migration Report Generation ──────────────────────────────────────────

describe('generateMigrationReport', () => {
  const report = generateMigrationReport(
    'ghost',
    'payload',
    'seed',
    {
      posts: 42,
      pages: 8,
      tags: 12,
      authors: 3,
      images: 67,
      imagesDownloaded: 60,
      imagesFailed: 2,
      redirects: 5,
      skippedDrafts: 3,
    },
    {
      seedScript: 'src/seed.ts',
      config: 'src/payload.config.ts',
      mediaDir: '/tmp/payload-project/media',
      envFile: '.env',
    },
    'ghost-export.json',
  );

  it('sets version to 1', () => {
    expect(report.version).toBe('1');
  });

  it('records source platform', () => {
    expect(report.source.platform).toBe('ghost');
    expect(report.source.exportFile).toBe('ghost-export.json');
  });

  it('records destination platform and method', () => {
    expect(report.destination.platform).toBe('payload');
    expect(report.destination.method).toBe('seed');
  });

  it('records summary counts', () => {
    expect(report.summary.posts).toBe(42);
    expect(report.summary.pages).toBe(8);
    expect(report.summary.tags).toBe(12);
    expect(report.summary.authors).toBe(3);
    expect(report.summary.images).toBe(67);
    expect(report.summary.imagesDownloaded).toBe(60);
    expect(report.summary.imagesFailed).toBe(2);
    expect(report.summary.redirects).toBe(5);
    expect(report.summary.skippedDrafts).toBe(3);
  });

  it('records output paths', () => {
    expect(report.output.seedScript).toBe('src/seed.ts');
    expect(report.output.config).toBe('src/payload.config.ts');
    expect(report.output.mediaDir).toBe('/tmp/payload-project/media');
    expect(report.output.envFile).toBe('.env');
  });

  it('records handoff template data', () => {
    expect(report.handoff.templateSlug).toBe('astro-payload');
    expect(report.handoff.templateName).toBe('Astro + Payload');
    expect(report.handoff.templateUrl).toContain('astro-payload');
    expect(report.handoff.pricing).toBe('paid');
  });

  it('records completion timestamp', () => {
    expect(report.completedAt).toBeTruthy();
    expect(new Date(report.completedAt).toISOString()).toBe(report.completedAt);
  });

  it('handles Astro destination with null output paths', () => {
    const astroReport = generateMigrationReport(
      'gatsby',
      'astro',
      'file',
      { posts: 10, pages: 2, tags: 5, authors: 1, images: 15, imagesDownloaded: 0, imagesFailed: 0, redirects: 3, skippedDrafts: 0 },
      {},
    );
    expect(astroReport.destination.platform).toBe('astro');
    expect(astroReport.output.seedScript).toBeUndefined();
    expect(astroReport.handoff.templateSlug).toBe('astro-blog');
    expect(astroReport.handoff.pricing).toBe('free');
  });

  it('handles unmatched destination gracefully', () => {
    const unmatchedReport = generateMigrationReport(
      'ghost',
      'strapi',
      'rest',
      { posts: 10, pages: 2, tags: 5, authors: 1, images: 15, imagesDownloaded: 0, imagesFailed: 0, redirects: 0, skippedDrafts: 0 },
      {},
    );
    expect(unmatchedReport.handoff.templateSlug).toBeNull();
    expect(unmatchedReport.handoff.templateName).toBeNull();
    expect(unmatchedReport.handoff.templateUrl).toBeNull();
    expect(unmatchedReport.handoff.pricing).toBeNull();
  });
});

// ── Migration Report File I/O ─────────────────────────────────────────────

describe('writeMigrationReport', () => {
  const tmpDir = resolve(__dirname, 'fixtures', 'creatives-tmp-test');

  it('writes migration-report.json to disk', () => {
    mkdirSync(tmpDir, { recursive: true });
    const report = generateMigrationReport(
      'ghost',
      'payload',
      'seed',
      { posts: 4, pages: 1, tags: 3, authors: 2, images: 5, imagesDownloaded: 5, imagesFailed: 0, redirects: 0, skippedDrafts: 1 },
      { seedScript: 'src/seed.ts', config: 'src/payload.config.ts', mediaDir: './media', envFile: '.env' },
    );
    const path = writeMigrationReport(report, tmpDir);
    expect(existsSync(path)).toBe(true);

    const read = JSON.parse(readFileSync(path, 'utf-8'));
    expect(read.version).toBe('1');
    expect(read.source.platform).toBe('ghost');
    expect(read.handoff.templateSlug).toBe('astro-payload');

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces valid JSON that round-trips', () => {
    mkdirSync(tmpDir, { recursive: true });
    const report = generateMigrationReport(
      'gatsby',
      'astro',
      'file',
      { posts: 20, pages: 5, tags: 8, authors: 4, images: 30, imagesDownloaded: 0, imagesFailed: 0, redirects: 2, skippedDrafts: 0 },
      {},
    );
    const path = writeMigrationReport(report, tmpDir);
    const read: MigrationReport = JSON.parse(readFileSync(path, 'utf-8'));
    expect(read.handoff.templateSlug).toBe('astro-blog');
    expect(read.summary.posts).toBe(20);

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
