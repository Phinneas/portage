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
} from '../src/report.js';
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

// ── report ────────────────────────────────────────────────────────────

describe('report', () => {
  describe('generateMarkdownReport', () => {
    it('generates a markdown report with route info', () => {
      const report = generateMigrationReport(
        'ghost', 'payload', 'seed',
        { posts: 42, pages: 8, tags: 12, authors: 3, images: 67, imagesDownloaded: 60, imagesFailed: 0, redirects: 5, skippedDrafts: 3 },
        { seedScript: 'src/seed.ts', config: 'src/payload.config.ts' },
      );
      const md = generateMarkdownReport(report);
      expect(md).toContain('ghost → payload');
      expect(md).toContain('| Posts | 42 |');
      expect(md).toContain('| Pages | 8 |');
      expect(md).toContain('src/seed.ts');
    });

    it('includes handoff template info', () => {
      const report = generateMigrationReport(
        'ghost', 'payload', 'seed',
        { posts: 10, pages: 2, tags: 5, authors: 1, images: 15, imagesDownloaded: 15, imagesFailed: 0, redirects: 0, skippedDrafts: 0 },
        {},
      );
      const md = generateMarkdownReport(report);
      expect(md).toContain('Astro + Payload');
    });
  });

  describe('writeMarkdownReport', () => {
    const tmpDir = resolve(__dirname, 'fixtures', 'report-tmp-test');

    it('writes migration-report.md to disk', () => {
      mkdirSync(tmpDir, { recursive: true });
      const report = generateMigrationReport(
        'gatsby', 'astro', 'file',
        { posts: 10, pages: 2, tags: 5, authors: 1, images: 15, imagesDownloaded: 0, imagesFailed: 0, redirects: 0, skippedDrafts: 0 },
        {},
      );
      const mdPath = writeMarkdownReport(report, tmpDir);
      expect(existsSync(mdPath)).toBe(true);
      const content = readFileSync(mdPath, 'utf-8');
      expect(content).toContain('gatsby → astro');

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
