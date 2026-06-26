import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { extractGatsby, mapPluginsToAstro } from '../src/gatsby.js';
import { transformContent, writeCollections, localizeAssets, writeRedirects } from '../src/astro-writer.js';
import { writeManifest, type Manifest } from '../src/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/gatsby-project');
const OUTPUT = resolve(__dirname, 'fixtures/test-load-output');

describe('load', () => {
  let manifest: Manifest;

  beforeAll(async () => {
    mkdirSync(OUTPUT, { recursive: true });
    const result = await extractGatsby({ source: FIXTURE, to: OUTPUT, dryRun: false });
    manifest = result.manifest;
    const transformResult = transformContent(manifest);
    manifest.transform = {
      fieldMappings: transformResult.mapped,
      rewrites: transformResult.rewrites,
      unmappedPlugins: [],
    };
    mapPluginsToAstro(manifest.extract.plugins);
    writeManifest(manifest, OUTPUT);
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('should write content collection files', () => {
    const result = writeCollections(manifest, OUTPUT, false);
    expect(result.written).toBeGreaterThan(0);
  });

  it('should write content.config.ts with glob loader and zod schema', () => {
    writeCollections(manifest, OUTPUT, false);
    const configPath = resolve(OUTPUT, 'src/content.config.ts');
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('defineCollection');
    expect(content).toContain('glob');
    expect(content).toContain('z.object');
    expect(content).toContain('pubDate');
    expect(content).toContain('heroImage');
    expect(content).toContain('export const collections');
  });

  it('should write astro.config.mjs with sitemap integration', () => {
    writeCollections(manifest, OUTPUT, false);
    const configPath = resolve(OUTPUT, 'astro.config.mjs');
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('trailingSlash');
    expect(content).toContain('sitemap');
  });

  it('should write blog posts to src/content/blog/', () => {
    writeCollections(manifest, OUTPUT, false);
    const postPath = resolve(OUTPUT, 'src/content/blog/leaving-gatsby.md');
    expect(existsSync(postPath)).toBe(true);
    const content = readFileSync(postPath, 'utf-8');
    expect(content).toContain('title:');
    expect(content).toContain('Leaving Gatsby Behind');
  });

  it('should map frontmatter fields correctly in output files', () => {
    writeCollections(manifest, OUTPUT, false);
    const content = readFileSync(resolve(OUTPUT, 'src/content/blog/leaving-gatsby.md'), 'utf-8');
    expect(content).toContain('pubDate:');
    expect(content).toContain('authors:');
  });

  it('should write pages to src/content/pages/', () => {
    writeCollections(manifest, OUTPUT, false);
    expect(existsSync(resolve(OUTPUT, 'src/content/pages/about.md'))).toBe(true);
  });

  it('should create asset directories', () => {
    const result = localizeAssets(manifest, OUTPUT, 'assets', false);
    expect(result).toBeDefined();
    expect(existsSync(resolve(OUTPUT, 'src/assets/blog'))).toBe(true);
  });

  it('should write redirect map', () => {
    const result = writeRedirects(manifest, OUTPUT, 'astro', false);
    expect(result).toBeDefined();
    expect(typeof result.count).toBe('number');
  });

  it('should handle dry-run mode without writing files', () => {
    const dryOutput = resolve(OUTPUT, 'dry-run-test');
    mkdirSync(dryOutput, { recursive: true });
    const result = writeCollections(manifest, dryOutput, true);
    expect(result.written).toBeGreaterThan(0);
    expect(existsSync(resolve(dryOutput, 'src/content.config.ts'))).toBe(false);
  });
});
