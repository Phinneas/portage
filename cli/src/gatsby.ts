/**
 * Gatsby project reader: config parsing, content walking, query harvesting,
 * image collection, slug derivation, and plugin mapping.
 * Owns everything about *reading* a Gatsby source.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import fg from 'fast-glob';
import { checksumFile, type Manifest, type ContentFile, type PluginMapping, type QueryMapping } from './manifest.js';
import { parseFrontmatter, ensureArray } from './frontmatter.js';

// ── Public API ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  source: string;
  to: string;
  queries?: string;
  dryRun?: boolean;
  includeDrafts?: boolean;
  gatsbyEnv?: string;
}

export interface ExtractResult {
  manifest: Manifest;
  dryRun: boolean;
}

export async function extractGatsby(opts: ExtractOptions): Promise<ExtractResult> {
  const sourceDir = resolve(opts.source);

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const manifest: Manifest = {
    version: '1',
    source: { platform: 'gatsby', path: sourceDir },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };

  // 1. Parse gatsby-config
  const configResult = parseGatsbyConfig(sourceDir);
  if (configResult) {
    manifest.extract.plugins = mapPlugins(configResult.plugins);
    manifest.extract.counts.plugins = manifest.extract.plugins.length;
  }

  // 2. Walk content directories
  const contentDirs = resolveContentDirs(sourceDir, configResult);
  for (const dir of contentDirs) {
    for (const f of collectContentFiles(sourceDir, dir)) {
      manifest.extract.contentFiles.push(f);
    }
  }

  // 3. Count posts vs pages
  for (const f of manifest.extract.contentFiles) {
    if (f.collection === 'blog') manifest.extract.counts.posts++;
    else if (f.collection === 'pages') manifest.extract.counts.pages++;
  }

  // 4. Collect images
  manifest.extract.images = collectImages(sourceDir);
  manifest.extract.counts.images = manifest.extract.images.length;

  // 5. Harvest GraphQL queries
  const queryGlob = opts.queries || 'src/templates/**/*.{js,jsx,ts,tsx}';
  manifest.extract.queries = harvestQueries(sourceDir, queryGlob);
  manifest.extract.counts.queries = manifest.extract.queries.length;

  // 6. Derive tags and authors from frontmatter
  const meta = countFrontmatterMeta(manifest.extract.contentFiles);
  manifest.extract.counts.tags = meta.tags;
  manifest.extract.counts.authors = meta.authors;

  return { manifest, dryRun: opts.dryRun ?? false };
}

// ── Gatsby config parsing ───────────────────────────────────────────────

interface GatsbyPluginEntry {
  resolve: string;
  options?: Record<string, unknown>;
}

interface GatsbyConfigResult {
  siteMetadata?: Record<string, unknown>;
  plugins: GatsbyPluginEntry[];
  trailingSlash?: string;
}

const CONFIG_FILES = ['gatsby-config.js', 'gatsby-config.mjs', 'gatsby-config.ts'];

function parseGatsbyConfig(sourceDir: string): GatsbyConfigResult | null {
  for (const name of CONFIG_FILES) {
    const fullPath = resolve(sourceDir, name);
    if (!existsSync(fullPath)) continue;
    try {
      return evalConfig(fullPath);
    } catch (err) {
      throw new Error(`Failed to parse ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

function evalConfig(fullPath: string): GatsbyConfigResult {
  // Try jiti for safe JS/TS evaluation
  try {
    const { createJiti: cj } = require('jiti') as typeof import('jiti');
    const jiti = cj(import.meta.url ?? __filename, { interopDefault: true });
    const mod = jiti(fullPath);
    const config = mod?.default ?? mod;
    if (typeof config === 'function') {
      return normalizeConfig(config({ env: process.env.NODE_ENV || 'production' }));
    }
    return normalizeConfig(config);
  } catch {
    // Fall through to manual parsing
  }
  return parseConfigManually(fullPath);
}

function normalizeConfig(config: Record<string, unknown>): GatsbyConfigResult {
  const plugins: GatsbyPluginEntry[] = [];
  if (Array.isArray(config.plugins)) {
    for (const p of config.plugins) {
      if (typeof p === 'string') plugins.push({ resolve: p });
      else if (p && typeof p === 'object') {
        plugins.push({
          resolve: (p as Record<string, unknown>).resolve as string,
          options: (p as Record<string, unknown>).options as Record<string, unknown> | undefined,
        });
      }
    }
  }
  return {
    siteMetadata: config.siteMetadata as Record<string, unknown> | undefined,
    plugins,
    trailingSlash: config.trailingSlash as string | undefined,
  };
}

function parseConfigManually(fullPath: string): GatsbyConfigResult {
  const content = readFileSync(fullPath, 'utf-8');
  const plugins: GatsbyPluginEntry[] = [];

  // Extract plugins with resolve: key (object form)
  const resolveRe = /resolve\s*:\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = resolveRe.exec(content)) !== null) {
    const pluginName = match[1];
    const optionsMatch = content.slice(match.index).match(/options\s*:\s*\{([^}]*)\}/s);
    let options: Record<string, unknown> | undefined;
    if (optionsMatch) {
      try { options = JSON.parse(`{${optionsMatch[1]}}`); } catch { options = undefined; }
    }
    plugins.push({ resolve: pluginName, options });
  }

  // Extract bare string plugins: 'gatsby-plugin-xxx' or "gatsby-plugin-xxx"
  const stringPluginRe = /['"](@?\w[\w-]*\/)?gatsby-[\w-]+['"]/g;
  const seenResolves = new Set(plugins.map((p) => p.resolve));
  while ((match = stringPluginRe.exec(content)) !== null) {
    const name = match[0].slice(1, -1); // strip quotes
    if (!seenResolves.has(name)) {
      plugins.push({ resolve: name });
      seenResolves.add(name);
    }
  }
  const titleMatch = content.match(/title\s*:\s*['"]([^'"]+)['"]/);
  const siteMetadata: Record<string, unknown> = {};
  if (titleMatch) siteMetadata.title = titleMatch[1];
  return {
    siteMetadata: Object.keys(siteMetadata).length ? siteMetadata : undefined,
    plugins,
  };
}

// ── Content walking ─────────────────────────────────────────────────────

function resolveContentDirs(sourceDir: string, config: GatsbyConfigResult | null): string[] {
  const dirs = new Set<string>();
  if (config) {
    for (const plugin of config.plugins) {
      if (plugin.resolve === 'gatsby-source-filesystem' && plugin.options?.path) {
        dirs.add(resolve(sourceDir, String(plugin.options.path)));
      }
    }
  }
  for (const d of ['src/pages', 'src/posts', 'src/content', 'content', 'posts', 'blog']) {
    const full = resolve(sourceDir, d);
    if (existsSync(full)) dirs.add(full);
  }
  return [...dirs];
}

function collectContentFiles(sourceDir: string, contentDir: string): ContentFile[] {
  const files: ContentFile[] = [];
  for (const pattern of ['**/*.md', '**/*.mdx']) {
    for (const absPath of fg.sync(pattern, { cwd: contentDir, absolute: true, onlyFiles: true })) {
      files.push({
        relativePath: relative(sourceDir, absPath),
        absolutePath: absPath,
        checksum: checksumFile(absPath),
        format: extname(absPath).slice(1) as 'md' | 'mdx',
        collection: classifyCollection(relative(sourceDir, absPath)),
      });
    }
  }
  return files;
}

function classifyCollection(path: string): ContentFile['collection'] {
  const lower = path.toLowerCase();
  if (lower.includes('/pages/') || lower.startsWith('src/pages/')) return 'pages';
  if (lower.includes('/posts/') || lower.includes('/blog/') || lower.includes('/content/')) return 'blog';
  return 'unknown';
}

// ── Image collection ────────────────────────────────────────────────────

function collectImages(sourceDir: string): Manifest['extract']['images'] {
  const images: Manifest['extract']['images'] = [];
  const patterns = [
    { pattern: 'src/images/**/*.{png,jpg,jpeg,gif,webp,svg,avif}', source: 'src/images' as const },
    { pattern: 'static/**/*.{png,jpg,jpeg,gif,webp,svg,avif}', source: 'static' as const },
    { pattern: 'public/**/*.{png,jpg,jpeg,gif,webp,svg,avif}', source: 'static' as const },
  ];
  for (const { pattern, source } of patterns) {
    for (const absPath of fg.sync(pattern, { cwd: sourceDir, absolute: true, onlyFiles: true })) {
      images.push({ relativePath: relative(sourceDir, absPath), absolutePath: absPath, source });
    }
  }
  return images;
}

// ── GraphQL query harvesting ────────────────────────────────────────────

function harvestQueries(sourceDir: string, globPattern: string): QueryMapping[] {
  const queries: QueryMapping[] = [];
  for (const filePath of fg.sync(globPattern, { cwd: sourceDir, absolute: true, onlyFiles: true })) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const relPath = relative(sourceDir, filePath);
      for (const pattern of [/graphql\s*`([\s\S]*?)`/g, /graphql\s*\(\s*`([\s\S]*?)`\s*\)/g]) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const parsed = parseQueryBody(match[1]);
          if (parsed) {
            queries.push({ sourceFile: relPath, nodeType: parsed.nodeType, fields: parsed.fields, resolved: true });
          }
        }
      }
    } catch { /* skip */ }
  }
  return queries;
}

interface ParsedQuery { nodeType: string; fields: string[] }

function parseQueryBody(body: string): ParsedQuery | null {
  let nodeType = 'unknown';

  // Try allXxx first (list queries)
  const allMatch = body.match(/\b(all\w+)\s*(?:\([^)]*\))?\s*\{/);
  if (allMatch) {
    nodeType = allMatch[1];
  } else {
    // Singular node after query declaration
    const firstBrace = body.indexOf('{');
    if (firstBrace >= 0) {
      const after = body.slice(firstBrace + 1).trim();
      const singular = after.match(/^\s*(\w+)\s*(?:\([^)]*\))?\s*\{/);
      if (singular) nodeType = singular[1];
    }
    if (nodeType === 'unknown') {
      const fallback = body.match(/\b(?!query\b)(\w+)\s*(?:\([^)]*\))?\s*\{/);
      if (fallback) nodeType = fallback[1];
    }
  }

  const fields: string[] = [];

  // Frontmatter fields
  for (const fm of body.matchAll(/frontmatter\s*\{([^}]+)\}/g)) {
    for (const line of fm[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
      const name = line.match(/^\w+/)?.[0];
      if (name) fields.push(`frontmatter.${name}`);
    }
  }

  // fields.* (Gatsby convention)
  for (const fm of body.matchAll(/fields\s*\{([^}]+)\}/g)) {
    for (const line of fm[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
      const name = line.match(/^\w+/)?.[0];
      if (name) fields.push(`fields.${name}`);
    }
  }

  // Fragment references
  for (const fr of body.matchAll(/\.\.\.(\w+)/g)) {
    fields.push(`fragment:${fr[1]}`);
  }

  return { nodeType, fields: [...new Set(fields)] };
}

// ── Plugin mapping ──────────────────────────────────────────────────────

const PLUGIN_MAP: Record<string, { equivalent: string | undefined; needsReview: boolean }> = {
  'gatsby-source-filesystem':    { equivalent: 'Content collections glob loader', needsReview: false },
  'gatsby-plugin-mdx':           { equivalent: 'Native MDX', needsReview: false },
  'gatsby-transformer-remark':   { equivalent: 'Native Markdown', needsReview: false },
  'gatsby-remark-images':        { equivalent: 'Astro image pipeline', needsReview: false },
  'gatsby-remark-prismjs':       { equivalent: 'Shiki / Expressive Code', needsReview: false },
  'gatsby-remark-autolink-headers': { equivalent: 'rehype-slug', needsReview: false },
  'gatsby-plugin-sitemap':       { equivalent: '@astrojs/sitemap', needsReview: false },
  'gatsby-plugin-react-helmet':  { equivalent: 'Astro <head>', needsReview: false },
  'gatsby-plugin-image':         { equivalent: 'astro:assets Image', needsReview: false },
  'gatsby-plugin-feed':          { equivalent: '@astrojs/rss', needsReview: false },
  'gatsby-plugin-postcss':       { equivalent: 'Astro PostCSS', needsReview: false },
  'gatsby-plugin-sass':          { equivalent: 'Astro Sass', needsReview: false },
  'gatsby-plugin-robots-txt':    { equivalent: 'public/robots.txt', needsReview: false },
  'gatsby-source-ghost':         { equivalent: undefined, needsReview: true },
  'gatsby-plugin-catch-links':   { equivalent: undefined, needsReview: true },
  'gatsby-plugin-manifest':      { equivalent: 'Astro PWA config', needsReview: true },
  'gatsby-plugin-offline':       { equivalent: 'Service worker (manual)', needsReview: true },
};

function mapPlugins(gatsbyPlugins: GatsbyPluginEntry[]): PluginMapping[] {
  return gatsbyPlugins.map((p) => {
    const mapping = PLUGIN_MAP[p.resolve];
    return {
      gatsbyPlugin: p.resolve,
      astroEquivalent: mapping?.equivalent,
      options: p.options as Record<string, unknown> | undefined,
      needsReview: mapping?.needsReview ?? true,
    };
  });
}

// ── Plugin registry (used by transform command) ─────────────────────────

const REGISTRY: Record<string, { astroEquivalent: string | undefined; configMapping?: (opts: Record<string, unknown>) => Record<string, unknown>; needsReview: boolean }> = {
  'gatsby-plugin-mdx':              { astroEquivalent: 'Native MDX (no plugin needed)', needsReview: false },
  'gatsby-transformer-remark':      { astroEquivalent: 'Native Markdown', needsReview: false },
  'gatsby-remark-images':           { astroEquivalent: 'Astro image pipeline', needsReview: false },
  'gatsby-remark-prismjs':          { astroEquivalent: 'Shiki / Expressive Code', configMapping: () => ({ syntaxHighlight: 'shiki' }), needsReview: false },
  'gatsby-remark-autolink-headers': { astroEquivalent: 'rehype-slug', needsReview: false },
  'gatsby-plugin-sitemap':          { astroEquivalent: '@astrojs/sitemap', needsReview: false },
  'gatsby-plugin-react-helmet':     { astroEquivalent: 'Astro <head>', needsReview: false },
  'gatsby-plugin-image':            { astroEquivalent: 'astro:assets Image', needsReview: false },
  'gatsby-plugin-feed':             { astroEquivalent: '@astrojs/rss', needsReview: false },
  'gatsby-plugin-postcss':          { astroEquivalent: 'Astro PostCSS (built-in)', needsReview: false },
  'gatsby-plugin-sass':             { astroEquivalent: 'Astro Sass (built-in)', needsReview: false },
  'gatsby-plugin-robots-txt':       { astroEquivalent: 'public/robots.txt', needsReview: false },
  'gatsby-source-filesystem':       { astroEquivalent: 'Content collections glob loader', needsReview: false, configMapping: (opts) => ({ base: opts.path }) },
  'gatsby-plugin-manifest':         { astroEquivalent: 'PWA configuration (manual)', needsReview: true },
  'gatsby-plugin-offline':          { astroEquivalent: 'Service worker (manual)', needsReview: true },
  'gatsby-plugin-catch-links':      { astroEquivalent: '(no equivalent needed)', needsReview: true },
  'gatsby-source-ghost':            { astroEquivalent: undefined, needsReview: true },
  'gatsby-source-contentful':       { astroEquivalent: 'Contentful integration or loader', needsReview: true },
  'gatsby-source-sanity':           { astroEquivalent: 'Sanity integration or loader', needsReview: true },
  'gatsby-source-wordpress':        { astroEquivalent: 'WordPress integration or loader', needsReview: true },
};

export interface PluginRegistryResult { mapped: number; unmapped: string[] }

export function mapPluginsToAstro(plugins: PluginMapping[]): PluginRegistryResult {
  let mapped = 0;
  const unmapped: string[] = [];
  for (const plugin of plugins) {
    const entry = REGISTRY[plugin.gatsbyPlugin];
    if (entry) {
      plugin.astroEquivalent = entry.astroEquivalent;
      plugin.needsReview = entry.needsReview;
      if (entry.configMapping && plugin.options) {
        plugin.options = { ...plugin.options, _astroConfig: entry.configMapping(plugin.options) };
      }
      if (!entry.needsReview) mapped++;
      else unmapped.push(plugin.gatsbyPlugin);
    } else {
      unmapped.push(plugin.gatsbyPlugin);
    }
  }
  return { mapped, unmapped };
}

// ── Slug derivation ─────────────────────────────────────────────────────

export function deriveSlug(relativePath: string): string {
  let slug = relativePath
    .replace(/^src\/(pages|posts|content)\//, '')
    .replace(/\.(md|mdx)$/, '')
    .replace(/\/index$/, '');
  const datePrefix = slug.match(/^\d{4}-\d{2}-\d{2}-(.+)/);
  if (datePrefix) slug = datePrefix[1];
  return slug.replace(/\/index$/, '');
}

// ── Frontmatter meta counting ──────────────────────────────────────────

function countFrontmatterMeta(files: ContentFile[]): { tags: number; authors: number } {
  const tagSet = new Set<string>();
  const authorSet = new Set<string>();
  for (const f of files) {
    try {
      const fm = parseFrontmatter(readFileSync(f.absolutePath, 'utf-8').match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || '');
      if (fm.tags) (Array.isArray(fm.tags) ? fm.tags : [fm.tags]).forEach((t: unknown) => tagSet.add(String(t)));
      if (fm.authors) (Array.isArray(fm.authors) ? fm.authors : [fm.authors]).forEach((a: unknown) => authorSet.add(String(a)));
      if (fm.author) authorSet.add(String(fm.author));
      if (fm.category || fm.categories) {
        const cats = ensureArray(fm.categories || fm.category);
        cats.forEach((c: unknown) => tagSet.add(String(c)));
      }
    } catch { /* skip */ }
  }
  return { tags: tagSet.size, authors: authorSet.size };
}
