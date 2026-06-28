import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  extractNext,
  deriveSlugFromPath,
  mapNextFrontmatter,
  mapNextPluginsToAstro,
  transformNextContent,
  rewriteNextLink,
  rewriteNextHead,
  deriveSlug,
  NEXT_FIELD_KEY_MAP,
} from '../src/next.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const NEXT_PROJECT = resolve(FIXTURES, 'next-project');

// ── Slug derivation ─────────────────────────────────────────────────────

describe('deriveSlugFromPath', () => {
  it('derives slug from simple page path', () => {
    expect(deriveSlugFromPath('about.mdx')).toBe('about');
  });

  it('derives slug from nested page path', () => {
    expect(deriveSlugFromPath('blog/first-post.mdx')).toBe('first-post');
  });

  it('derives slug from dynamic route', () => {
    expect(deriveSlugFromPath('blog/[slug].mdx')).toBe('slug');
  });

  it('derives slug from catch-all route', () => {
    expect(deriveSlugFromPath('docs/[...slug].mdx')).toBe('slug');
  });

  it('handles index page', () => {
    expect(deriveSlugFromPath('index.mdx')).toBe('index');
  });

  it('handles nested index page', () => {
    expect(deriveSlugFromPath('blog/index.mdx')).toBe('blog');
  });
});

// ── Frontmatter mapping ──────────────────────────────────────────────────

describe('mapNextFrontmatter', () => {
  it('maps title', () => {
    const fm = mapNextFrontmatter({ title: 'Test Post' });
    expect(fm.title).toBe('Test Post');
  });

  it('maps date to pubDate', () => {
    const fm = mapNextFrontmatter({ date: '2024-01-15' });
    expect(fm.pubDate).toBeDefined();
  });

  it('maps tags as array', () => {
    const fm = mapNextFrontmatter({ tags: ['javascript', 'webdev'] });
    expect(fm.tags).toEqual(['javascript', 'webdev']);
  });

  it('maps author to authors array', () => {
    const fm = mapNextFrontmatter({ author: 'Alice Chen' });
    expect(fm.authors).toEqual(['Alice Chen']);
  });

  it('maps excerpt to description', () => {
    const fm = mapNextFrontmatter({ excerpt: 'A brief summary' });
    expect(fm.description).toBe('A brief summary');
  });

  it('maps draft as boolean', () => {
    const fm = mapNextFrontmatter({ draft: true });
    expect(fm.draft).toBe(true);
  });

  it('maps heroImage with path rewrite', () => {
    const fm = mapNextFrontmatter({ heroImage: '/images/hero.jpg' });
    expect(fm.heroImage).toContain('assets');
  });

  it('maps categories', () => {
    const fm = mapNextFrontmatter({ categories: ['Tech', 'Design'] });
    expect(fm.categories).toEqual(['Tech', 'Design']);
  });

  it('handles empty frontmatter', () => {
    const fm = mapNextFrontmatter({});
    expect(fm.access).toBe('public');
    expect(fm.title).toBeUndefined();
    expect(fm.pubDate).toBeUndefined();
  });

  it('maps updated date', () => {
    const fm = mapNextFrontmatter({ updated: '2025-03-15' });
    expect(fm.updatedDate).toBeTruthy();
  });

  it('maps heroImageAlt', () => {
    const fm = mapNextFrontmatter({ heroImageAlt: 'Alt text' });
    expect(fm.heroImageAlt).toBe('Alt text');
  });

  it('maps featured flag', () => {
    const fm = mapNextFrontmatter({ featured: true });
    expect(fm.featured).toBe(true);
  });

  it('maps canonical URL', () => {
    const fm = mapNextFrontmatter({ canonical_url: '/old-path' });
    expect(fm.canonicalURL).toBe('/old-path');
  });

  it('maps SEO from nested object', () => {
    const fm = mapNextFrontmatter({ seo: { title: 'SEO Title', description: 'SEO Desc' } });
    expect(fm.seo).toEqual({ title: 'SEO Title', description: 'SEO Desc' });
  });

  it('maps SEO from flat fields', () => {
    const fm = mapNextFrontmatter({ seoTitle: 'Flat SEO', seoDescription: 'Flat Desc' });
    expect(fm.seo).toEqual({ title: 'Flat SEO', description: 'Flat Desc' });
  });

  it('sets originalId from relativePath', () => {
    const fm = mapNextFrontmatter({ title: 'Test' }, 'pages/about.mdx');
    expect(fm.originalId).toBeTruthy();
    expect(typeof fm.originalId).toBe('string');
  });

  it('sets access to public by default', () => {
    const fm = mapNextFrontmatter({ title: 'Test' });
    expect(fm.access).toBe('public');
  });
});

// ── Component rewrites ──────────────────────────────────────────────────

describe('rewriteNextLink', () => {
  it('replaces Link with anchor', () => {
    const input = `<Link href="/about">About</Link>`;
    const result = rewriteNextLink(input);
    expect(result).toContain('<a href="/about"');
    expect(result).toContain('</a>');
    expect(result).not.toContain('<Link');
  });

  it('removes next/link import', () => {
    const input = `import Link from 'next/link';\n<Link href="/">Home</Link>`;
    const result = rewriteNextLink(input);
    expect(result).not.toContain("import Link from 'next/link'");
  });
});

describe('rewriteNextHead', () => {
  it('removes next/head import', () => {
    const input = `import Head from 'next/head';\n<Head><title>Test</title></Head>`;
    const result = rewriteNextHead(input);
    expect(result).not.toContain("import Head from 'next/head'");
    expect(result).not.toContain('<Head>');
  });
});

// ── Plugin mapping ──────────────────────────────────────────────────────

describe('mapNextPluginsToAstro', () => {
  it('maps @next/mdx to @astrojs/mdx', () => {
    const plugins = [{ gatsbyPlugin: '@next/mdx', needsReview: false }];
    const result = mapNextPluginsToAstro(plugins);
    expect(plugins[0].astroEquivalent).toBe('@astrojs/mdx');
    expect(result.mapped).toBe(1);
  });

  it('flags next/router as unmapped', () => {
    const plugins = [{ gatsbyPlugin: 'next/router', needsReview: false }];
    const result = mapNextPluginsToAstro(plugins);
    expect(result.unmapped).toContain('next/router');
  });

  it('maps next-sitemap to @astrojs/sitemap', () => {
    const plugins = [{ gatsbyPlugin: 'next-sitemap', needsReview: false }];
    const result = mapNextPluginsToAstro(plugins);
    expect(plugins[0].astroEquivalent).toBe('@astrojs/sitemap');
  });
});

// ── Field key map ────────────────────────────────────────────────────────

describe('NEXT_FIELD_KEY_MAP', () => {
  it('maps all expected Next.js fields', () => {
    expect(NEXT_FIELD_KEY_MAP.title).toBe('title');
    expect(NEXT_FIELD_KEY_MAP.date).toBe('pubDate');
    expect(NEXT_FIELD_KEY_MAP.tags).toBe('tags');
    expect(NEXT_FIELD_KEY_MAP.author).toBe('authors');
    expect(NEXT_FIELD_KEY_MAP.excerpt).toBe('description');
    expect(NEXT_FIELD_KEY_MAP.draft).toBe('draft');
    expect(NEXT_FIELD_KEY_MAP.heroImage).toBe('heroImage');
  });
});

// ── Full extraction ──────────────────────────────────────────────────────

describe('extractNext', () => {
  it('extracts from Next.js project and returns manifest', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    expect(result.manifest.source.platform).toBe('next');
    expect(result.manifest.extract.counts.posts).toBe(2);
    expect(result.manifest.extract.counts.pages).toBeGreaterThanOrEqual(1);
  });

  it('detects @next/mdx plugin', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const mdxPlugin = result.manifest.extract.plugins.find(p => p.gatsbyPlugin === '@next/mdx');
    expect(mdxPlugin).toBeDefined();
    expect(mdxPlugin?.astroEquivalent).toBe('@astrojs/mdx');
  });

  it('detects image domains from config', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const domainPlugin = result.manifest.extract.plugins.find(p => p.gatsbyPlugin.includes('external domains'));
    expect(domainPlugin).toBeDefined();
  });

  it('detects redirects from config', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const redirectPlugin = result.manifest.extract.plugins.find(p => p.gatsbyPlugin.includes('redirects'));
    expect(redirectPlugin).toBeDefined();
  });

  it('collects content files from pages/', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    expect(result.manifest.extract.contentFiles.length).toBeGreaterThanOrEqual(3);
  });

  it('skips _app, _document, and api files', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const skipped = result.manifest.extract.contentFiles.filter(f =>
      f.relativePath.includes('_app') || f.relativePath.includes('_document')
    );
    expect(skipped.length).toBe(0);
  });

  it('collects images from public/', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    expect(result.manifest.extract.counts.images).toBeGreaterThanOrEqual(1);
  });

  it('throws for missing source directory', async () => {
    await expect(
      extractNext({ source: '/nonexistent', to: '/tmp' })
    ).rejects.toThrow('Source directory not found');
  });

  it('throws for missing pages/ directory', async () => {
    await expect(
      extractNext({ source: resolve(FIXTURES, 'gatsby-project'), to: '/tmp' })
    ).rejects.toThrow('No pages/ directory');
  });

  it('throws for app router', async () => {
    await expect(
      extractNext({ source: NEXT_PROJECT, to: '/tmp', router: 'app' })
    ).rejects.toThrow('App router extraction is not yet supported');
  });

  it('audits next/* imports', async () => {
    const result = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    expect(result.manifest.extract.queries.length).toBeGreaterThan(0);
  });
});

// ── Transform ─────────────────────────────────────────────────────────────

describe('transformNextContent', () => {
  it('maps frontmatter fields', async () => {
    const extractResult = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const result = transformNextContent(extractResult.manifest);
    expect(result.mapped).toBeGreaterThan(0);
  });

  it('tracks component rewrites', async () => {
    const extractResult = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const result = transformNextContent(extractResult.manifest);
    const linkRewrites = result.rewrites.filter(r => r.type === 'link');
    expect(linkRewrites.length).toBeGreaterThan(0);
  });

  it('tracks image rewrites', async () => {
    const extractResult = await extractNext({
      source: NEXT_PROJECT,
      to: resolve(FIXTURES, 'next-project'),
    });
    const result = transformNextContent(extractResult.manifest);
    const imageRewrites = result.rewrites.filter(r => r.type === 'image');
    expect(imageRewrites.length).toBeGreaterThan(0);
  });
});

// ── Slug derivation (from absolute path) ────────────────────────────────

describe('deriveSlug', () => {
  it('derives slug from absolute path', () => {
    const absPath = resolve(NEXT_PROJECT, 'pages/blog/first-post.mdx');
    const slug = deriveSlug(absPath, NEXT_PROJECT);
    expect(slug).toBe('first-post');
  });

  it('derives slug from about page', () => {
    const absPath = resolve(NEXT_PROJECT, 'pages/about.mdx');
    const slug = deriveSlug(absPath, NEXT_PROJECT);
    expect(slug).toBe('about');
  });
});
