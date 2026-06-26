import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractGatsby } from '../src/gatsby.js';
import { writeManifest } from '../src/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/gatsby-project');
const OUTPUT = resolve(__dirname, 'fixtures/test-output');

describe('extract --from gatsby', () => {
  beforeAll(() => {
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) {
      rmSync(OUTPUT, { recursive: true, force: true });
    }
  });

  it('should extract content files from a Gatsby project', async () => {
    const result = await extractGatsby({
      source: FIXTURE,
      to: OUTPUT,
      dryRun: true,
    });

    expect(result.manifest.source.platform).toBe('gatsby');
    expect(result.manifest.extract.contentFiles.length).toBeGreaterThan(0);
  });

  it('should find blog posts', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.counts.posts).toBeGreaterThanOrEqual(2);
  });

  it('should find pages', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.counts.pages).toBeGreaterThanOrEqual(1);
  });

  it('should parse gatsby-config.js plugins', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.plugins.length).toBeGreaterThan(0);
    const pluginNames = result.manifest.extract.plugins.map((p) => p.gatsbyPlugin);
    expect(pluginNames).toContain('gatsby-source-filesystem');
    expect(pluginNames).toContain('gatsby-plugin-mdx');
    expect(pluginNames).toContain('gatsby-transformer-remark');
  });

  it('should map known plugins to Astro equivalents', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    const mdx = result.manifest.extract.plugins.find((p) => p.gatsbyPlugin === 'gatsby-plugin-mdx');
    expect(mdx?.astroEquivalent).toBe('Native MDX');
    const sitemap = result.manifest.extract.plugins.find((p) => p.gatsbyPlugin === 'gatsby-plugin-sitemap');
    expect(sitemap?.astroEquivalent).toBe('@astrojs/sitemap');
  });

  it('should harvest GraphQL queries from templates', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.queries.length).toBeGreaterThanOrEqual(2);
    const nodeTypes = result.manifest.extract.queries.map((q) => q.nodeType);
    expect(nodeTypes).toContain('markdownRemark');
  });

  it('should collect images from src/images', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.images).toBeDefined();
  });

  it('should extract tags from frontmatter', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.counts.tags).toBeGreaterThan(0);
  });

  it('should extract authors from frontmatter', async () => {
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: true });
    expect(result.manifest.extract.counts.authors).toBeGreaterThan(0);
  });
});
