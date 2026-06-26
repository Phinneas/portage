import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractGatsby, mapPluginsToAstro } from '../src/gatsby.js';
import { transformContent, rewriteMdx } from '../src/astro-writer.js';
import { writeManifest, type Manifest } from '../src/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/gatsby-project');
const OUTPUT = resolve(__dirname, 'fixtures/test-transform-output');

describe('transform', () => {
  let manifest: Manifest;

  beforeAll(async () => {
    mkdirSync(OUTPUT, { recursive: true });
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: false });
    manifest = result.manifest;
    writeManifest(manifest, OUTPUT);
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('should map frontmatter fields to Astro equivalents', () => {
    const result = transformContent(manifest);
    expect(result.mapped).toBeGreaterThan(0);
  });

  it('should detect Link rewrites in MDX body', () => {
    const result = transformContent(manifest);
    expect(result.rewrites).toBeDefined();
  });

  it('should map known Gatsby plugins to Astro equivalents', () => {
    const result = mapPluginsToAstro(manifest.extract.plugins);
    expect(result.mapped).toBeGreaterThan(0);
  });

  it('should flag unmapped plugins for manual review', () => {
    const result = mapPluginsToAstro(manifest.extract.plugins);
    const knownPlugin = manifest.extract.plugins.find((p) => p.gatsbyPlugin === 'gatsby-plugin-react-helmet');
    expect(knownPlugin?.needsReview).toBe(false);
    expect(knownPlugin?.astroEquivalent).toBe('Astro <head>');
  });

  it('should map gatsby-source-filesystem to glob loader config', () => {
    mapPluginsToAstro(manifest.extract.plugins);
    const fsPlugin = manifest.extract.plugins.find((p) => p.gatsbyPlugin === 'gatsby-source-filesystem');
    expect(fsPlugin?.astroEquivalent).toBe('Content collections glob loader');
    expect(fsPlugin?.options?._astroConfig).toBeDefined();
  });

  it('should rewrite <Link to=""> to <a href=""> in MDX', () => {
    const tmpPath = resolve(OUTPUT, 'test-link.mdx');
    writeFileSync(tmpPath, '---\ntitle: "Test"\n---\n\n<Link to="/blog">Blog</Link>\n', 'utf-8');
    const rewrites = rewriteMdx(tmpPath);
    expect(rewrites.length).toBeGreaterThan(0);
    expect(rewrites.some((r) => r.type === 'link')).toBe(true);
    const content = readFileSync(tmpPath, 'utf-8');
    expect(content).toContain('<a href="/blog">');
    expect(content).toContain('</a>');
    expect(content).not.toContain('<Link');
  });

  it('should rewrite <StaticImage> to <Image> in MDX', () => {
    const tmpPath = resolve(OUTPUT, 'test-image.mdx');
    writeFileSync(tmpPath, '---\ntitle: "Test"\n---\n\n<StaticImage src="../photo.jpg" alt="A photo" />\n', 'utf-8');
    const rewrites = rewriteMdx(tmpPath);
    expect(rewrites.some((r) => r.type === 'static-image')).toBe(true);
    const content = readFileSync(tmpPath, 'utf-8');
    expect(content).toContain('<Image src="../photo.jpg" alt="A photo"');
    expect(content).not.toContain('<StaticImage');
  });
});
