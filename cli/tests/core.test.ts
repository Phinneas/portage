import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import {
  checksumString,
  downloadImage,
  downloadAllRemoteImages,
  sqspUrlTransform,
  sqspFilenameTransform,
  ghostUrlTransform,
  ghostFilenameTransform,
  substackUrlTransform,
  substackFilenameTransform,
} from '../src/asset_handler.js';
import {
  convertHtmlToMarkdown,
  stripSquarespaceMarkup,
  stripSubstackMarkup,
  htmlToPortableText,
  stripTags,
} from '../src/block_parser.js';
import {
  generateMigrationReport,
  generateMarkdownReport,
  writeMigrationReport,
  writeMarkdownReport,
  buildMigrationRecords,
  validateMigrationReport,
} from '../src/report.js';
import type { ReportInput, MigrationItem } from '../src/report.js';
import {
  validateConfig,
  readConfigYaml,
  SUPPORTED_PLATFORMS,
  SUPPORTED_DESTINATIONS,
} from '../src/config.js';
import {
  parallelMap,
  sequentialMap,
} from '../src/workers.js';

// ── asset_handler ──────────────────────────────────────────────────────

describe('asset_handler', () => {
  describe('checksumString', () => {
    it('produces a 12-char hex string', () => {
      const hash = checksumString('hello world');
      expect(hash).toHaveLength(12);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('is deterministic', () => {
      expect(checksumString('test')).toBe(checksumString('test'));
    });

    it('produces different hashes for different content', () => {
      expect(checksumString('a')).not.toBe(checksumString('b'));
    });
  });

  describe('URL transforms', () => {
    it('sqspUrlTransform adds 2500w format', () => {
      expect(sqspUrlTransform('https://images.squarespace-cdn.com/x.jpg')).toContain('?format=2500w');
      expect(sqspUrlTransform('https://images.squarespace-cdn.com/x.jpg?format=750w')).toContain('?format=2500w');
    });

    it('sqspFilenameTransform strips format param', () => {
      expect(sqspFilenameTransform('https://images.squarespace-cdn.com/x.jpg?format=750w')).not.toContain('?');
    });

    it('ghostUrlTransform strips size variants', () => {
      expect(ghostUrlTransform('https://blog.example.com/size/w600/images/x.jpg')).toContain('/content/images/');
      expect(ghostUrlTransform('https://blog.example.com/size/w600/images/x.jpg')).not.toContain('/size/');
    });

    it('ghostFilenameTransform strips size and format', () => {
      const result = ghostFilenameTransform('https://blog.example.com/size/w600/images/x.jpg?format=webp');
      expect(result).not.toContain('/size/');
      expect(result).not.toContain('?');
    });

    it('substackUrlTransform strips resize params', () => {
      const result = substackUrlTransform('https://substackcdn.com/image/x.jpg?format=webp&w=600');
      expect(result).not.toContain('format=');
      expect(result).not.toContain('w=');
    });

    it('substackFilenameTransform strips all query params', () => {
      expect(substackFilenameTransform('https://substackcdn.com/image/x.jpg?format=webp&w=600')).not.toContain('?');
    });
  });
});

// ── block_parser ──────────────────────────────────────────────────────

describe('block_parser', () => {
  describe('convertHtmlToMarkdown (generic)', () => {
    it('converts a simple paragraph', () => {
      const md = convertHtmlToMarkdown('<p>Hello world</p>', 'generic');
      expect(md.trim()).toBe('Hello world');
    });

    it('converts headings', () => {
      const md = convertHtmlToMarkdown('<h2>Section</h2>', 'generic');
      expect(md).toContain('## Section');
    });
  });

  describe('stripSquarespaceMarkup', () => {
    it('removes sqs-block class attributes', () => {
      const result = stripSquarespaceMarkup('<div class="sqs-block sqs-block-html"><p>Text</p></div>');
      expect(result).not.toContain('sqs-block');
      expect(result).toContain('<p>Text</p>');
    });

    it('removes data attributes', () => {
      const result = stripSquarespaceMarkup('<div data-test="yes">Text</div>');
      expect(result).not.toContain('data-test');
    });
  });

  describe('stripSubstackMarkup', () => {
    it('removes subscribe widgets', () => {
      const result = stripSubstackMarkup('<div class="subscribe-widget">Subscribe!</div>');
      expect(result).not.toContain('subscribe-widget');
    });
  });

  describe('stripTags', () => {
    it('strips all HTML tags', () => {
      expect(stripTags('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    });

    it('decodes HTML entities', () => {
      expect(stripTags('a &amp; b')).toBe('a & b');
      expect(stripTags('a &lt; b')).toBe('a < b');
    });

    it('trims whitespace', () => {
      expect(stripTags('  hello  ')).toBe('hello');
    });
  });
});

// ── report (Migration Report Schema v1.0) ───────────────────────────────

function sampleItems(): MigrationItem[] {
  return [
    { sourceUrl: 'https://blog.example.com/welcome', slug: 'welcome', collection: 'blog', draft: false, checksum: 'abc123def456' },
    { sourceUrl: 'https://blog.example.com/under-construction', slug: 'under-construction', collection: 'blog', draft: true },
    { sourceUrl: 'https://blog.example.com/lexical-post', slug: 'lexical-post', collection: 'blog', draft: false, lexical: true },
    { sourceUrl: 'https://blog.example.com/failed-images', slug: 'failed-images', collection: 'blog', draft: false, contentHtml: '<img src="https://cdn.example.com/broken.jpg">' },
  ];
}

function sampleReportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    destinationBaseUrl: 'https://example.com',
    destinationPlatform: 'payload',
    records: buildMigrationRecords(sampleItems(), {
      sourcePlatform: 'ghost',
      sourceSiteUrl: 'https://blog.example.com',
      failedImageUrls: new Set(['https://cdn.example.com/broken.jpg']),
    }),
    ...overrides,
  };
}

describe('report', () => {
  describe('buildMigrationRecords', () => {
    it('maps items to v1.0 records with all six required fields', () => {
      const records = buildMigrationRecords(sampleItems(), {
        sourcePlatform: 'ghost',
        sourceSiteUrl: 'https://blog.example.com',
        failedImageUrls: new Set(),
      });
      expect(records).toHaveLength(4);
      const r = records[0];
      expect(r.source_platform).toBe('ghost');
      expect(r.source_url).toBe('https://blog.example.com/welcome');
      expect(r.destination_path).toBe('/blog/welcome/');
      expect(r.status).toBe('migrated');
      expect(r.images_rehosted).toBe(true);
      expect(r.links_rewritten).toBe(true);
      expect(r.checksum).toBe('abc123def456');
    });

    it('classifies drafts as excluded and lexical content as quarantined', () => {
      const records = buildMigrationRecords(sampleItems(), {
        sourcePlatform: 'ghost',
        sourceSiteUrl: 'https://blog.example.com',
        failedImageUrls: new Set(),
      });
      expect(records[1].status).toBe('excluded');
      expect(records[1].destination_path).toBe('/blog/under-construction/');
      expect(records[2].status).toBe('quarantined');
      expect(records[2].reason).toContain('Lexical');
    });

    it('flags items whose content references a failed image download', () => {
      const records = buildMigrationRecords(sampleItems(), {
        sourcePlatform: 'ghost',
        sourceSiteUrl: 'https://blog.example.com',
        failedImageUrls: new Set(['https://cdn.example.com/broken.jpg']),
      });
      expect(records[3].images_rehosted).toBe(false);
      expect(records[0].images_rehosted).toBe(true);
    });

    it('derives source URL from the site URL when the platform records none', () => {
      const records = buildMigrationRecords(
        [{ sourceUrl: null, slug: 'about', collection: 'pages', draft: false }],
        { sourcePlatform: 'jekyll', sourceSiteUrl: 'https://oldsite.com', failedImageUrls: new Set() },
      );
      expect(records[0].source_url).toBe('https://oldsite.com/pages/about/');
    });
  });

  describe('generateMigrationReport', () => {
    it('produces a v1.0 standard report', () => {
      const report = generateMigrationReport(sampleReportInput());
      expect(report.version).toBe('1.0');
      expect(report.destination_platform).toBe('payload');
      expect(report.destination_base_url).toBe('https://example.com');
      expect(report.generated_by).toMatch(/^portage@/);
      expect(report.generated_at).toMatch(/T.*Z$/);
      expect(report.records).toHaveLength(4);
    });

    it('rejects a non-conforming status on validation', () => {
      const report = generateMigrationReport(sampleReportInput());
      (report.records[0] as unknown as { status: string }).status = 'maybe';
      expect(() => validateMigrationReport(report)).toThrow();
    });
  });

  describe('generateMarkdownReport', () => {
    it('generates a markdown report with route info and status summary', () => {
      const report = generateMigrationReport(sampleReportInput());
      const md = generateMarkdownReport(report);
      expect(md).toContain('ghost → payload');
      expect(md).toContain('Destination base URL:** https://example.com');
      expect(md).toContain('| migrated | 2 |');
      expect(md).toContain('| excluded | 1 |');
      expect(md).toContain('https://blog.example.com/welcome');
    });

    it('flags images not rehosted', () => {
      const report = generateMigrationReport(sampleReportInput());
      const md = generateMarkdownReport(report);
      expect(md).toContain('## Images not rehosted (1)');
      expect(md).toContain('https://blog.example.com/failed-images');
    });

    it('lists quarantined items under needs review', () => {
      const report = generateMigrationReport(sampleReportInput());
      const md = generateMarkdownReport(report);
      expect(md).toContain('## Needs Review (1)');
      expect(md).toContain('lexical-post');
    });
  });

  describe('writeMigrationReport', () => {
    const tmpDir = resolve(__dirname, 'fixtures', 'report-json-tmp-test');

    it('writes a schema-valid migration-report.json', () => {
      mkdirSync(tmpDir, { recursive: true });
      const report = generateMigrationReport(sampleReportInput());
      const jsonPath = writeMigrationReport(report, tmpDir);
      expect(existsSync(jsonPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      expect(parsed.version).toBe('1.0');
      expect(parsed.records).toHaveLength(4);
      for (const field of ['source_platform', 'source_url', 'destination_path', 'status', 'images_rehosted', 'links_rewritten']) {
        expect(parsed.records[0]).toHaveProperty(field);
      }
      // the written file re-validates against the standard
      expect(() => validateMigrationReport(parsed)).not.toThrow();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('refuses to write a non-conforming report', () => {
      mkdirSync(tmpDir, { recursive: true });
      const report = generateMigrationReport(sampleReportInput());
      (report as unknown as { version: string }).version = '0.9';
      expect(() => writeMigrationReport(report, tmpDir)).toThrow();
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('writeMarkdownReport', () => {
    const tmpDir = resolve(__dirname, 'fixtures', 'report-md-tmp-test');

    it('writes migration-report.md to disk', () => {
      mkdirSync(tmpDir, { recursive: true });
      const report = generateMigrationReport({ ...sampleReportInput(), destinationPlatform: 'astro' });
      const mdPath = writeMarkdownReport(report, tmpDir);
      expect(existsSync(mdPath)).toBe(true);
      const content = readFileSync(mdPath, 'utf-8');
      expect(content).toContain('ghost → astro');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

// ── config ────────────────────────────────────────────────────────────

describe('config', () => {
  describe('validateConfig', () => {
    it('validates ghost requires --export', () => {
      const result = validateConfig('ghost', undefined, undefined);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('export');
    });

    it('validates gatsby requires --source', () => {
      const result = validateConfig('gatsby', undefined, undefined);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('source');
    });

    it('accepts valid ghost config', () => {
      const result = validateConfig('ghost', undefined, resolve(__dirname, 'fixtures/ghost-export/ghost-export.json'));
      expect(result.valid).toBe(true);
    });

    it('rejects unsupported platform', () => {
      const result = validateConfig('drupal', undefined, undefined);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Unsupported platform');
    });

    it('rejects missing export file', () => {
      const result = validateConfig('ghost', undefined, '/nonexistent/file.json');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('not found');
    });
  });

  describe('SUPPORTED_PLATFORMS', () => {
    it('includes all current platforms', () => {
      expect(SUPPORTED_PLATFORMS).toContain('gatsby');
      expect(SUPPORTED_PLATFORMS).toContain('ghost');
      expect(SUPPORTED_PLATFORMS).toContain('jekyll');
      expect(SUPPORTED_PLATFORMS).toContain('squarespace');
      expect(SUPPORTED_PLATFORMS).toContain('substack');
      expect(SUPPORTED_PLATFORMS).toContain('next');
    });
  });

  describe('SUPPORTED_DESTINATIONS', () => {
    it('includes astro, payload, sanity', () => {
      expect(SUPPORTED_DESTINATIONS).toContain('astro');
      expect(SUPPORTED_DESTINATIONS).toContain('payload');
      expect(SUPPORTED_DESTINATIONS).toContain('sanity');
    });
  });

  describe('readConfigYaml', () => {
    const tmpDir = resolve(__dirname, 'fixtures', 'config-tmp-test');

    it('reads a simple config.yaml', () => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(resolve(tmpDir, 'config.yaml'), 'platform: ghost\nmethod: seed\nconcurrency: 5\n', 'utf-8');
      const config = readConfigYaml(resolve(tmpDir, 'config.yaml'));
      expect(config).not.toBeNull();
      expect(config!.platform).toBe('ghost');
      expect(config!.method).toBe('seed');
      expect(config!.concurrency).toBe(5);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null for missing file', () => {
      expect(readConfigYaml('/nonexistent/config.yaml')).toBeNull();
    });
  });
});

// ── workers ──────────────────────────────────────────────────────────

describe('workers', () => {
  describe('parallelMap', () => {
    it('processes items with concurrency 1', async () => {
      const items = [1, 2, 3];
      const result = await parallelMap(items, async (n) => n * 2, {
        concurrency: 1,
        keyFn: (_item: unknown) => String(_item),
      });
      expect(result.completed).toEqual([2, 4, 6]);
      expect(result.total).toBe(3);
      expect(result.failed.length).toBe(0);
    });

    it('handles failures', async () => {
      const items = [1, 2, 3];
      const result = await parallelMap(items, async (n) => {
        if (n === 2) throw new Error('fail on 2');
        return n;
      }, {
        concurrency: 1,
        keyFn: (_item: unknown) => String(_item),
      });
      expect(result.completed.length).toBe(2);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].error).toBe('fail on 2');
    });

    it('tracks duration', async () => {
      const result = await parallelMap([1], async (n) => n, {
        concurrency: 1,
        keyFn: (_item: unknown) => String(_item),
      });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('sequentialMap', () => {
    it('processes items sequentially', async () => {
      const items = ['a', 'b', 'c'];
      const result = await sequentialMap(items, async (s) => s.toUpperCase(), {
        keyFn: (_item: unknown) => String(_item),
      });
      expect(result.completed).toEqual(['A', 'B', 'C']);
    });
  });
});
