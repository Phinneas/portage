/**
 * Next.js project reader: pages-router scanning, next.config parsing,
 * getStaticProps/getStaticPaths extraction, next/image and next/link
 * detection, layout extraction, and component mapping.
 * Owns everything about *reading* a Next.js (pages router) project.
 *
 * Scope: pages router only (v0.1). App router deferred.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, relative, basename } from 'node:path';
import fg from 'fast-glob';
import { checksumFile, type Manifest, type ContentFile, type PluginMapping } from './manifest.js';
import { splitFrontmatter, ensureArray, coerceDate, coerceBoolean } from './frontmatter.js';

// ── Public API ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  source: string;
  to: string;
  router?: 'pages' | 'app';
  dryRun?: boolean;
  includeDrafts?: boolean;
}

export interface ExtractResult {
  manifest: Manifest;
  dryRun: boolean;
}

export async function extractNext(opts: ExtractOptions): Promise<ExtractResult> {
  const sourceDir = resolve(opts.source);

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const router = opts.router || 'pages';
  if (router !== 'pages') {
    throw new Error(`App router extraction is not yet supported. Use --router pages.`);
  }

  // Verify pages directory exists
  const pagesDir = resolve(sourceDir, 'pages');
  if (!existsSync(pagesDir)) {
    throw new Error(`No pages/ directory found at ${pagesDir}. Is this a Next.js pages-router project?`);
  }

  const manifest: Manifest = {
    version: '1',
    source: { platform: 'next', path: sourceDir },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };

  // 1. Parse next.config
  const configResult = parseNextConfig(sourceDir);
  if (configResult) {
    manifest.extract.plugins = mapPlugins(configResult);
    manifest.extract.counts.plugins = manifest.extract.plugins.length;
  }

  // 2. Walk pages/ for MDX/MD content files
  for (const f of collectContentPages(sourceDir)) {
    manifest.extract.contentFiles.push(f);
  }

  // 3. Walk pages/ for JS/TS pages with getStaticProps
  for (const f of collectStaticPages(sourceDir)) {
    manifest.extract.contentFiles.push(f);
  }

  // 4. Count posts vs pages
  for (const f of manifest.extract.contentFiles) {
    if (f.collection === 'blog') manifest.extract.counts.posts++;
    else manifest.extract.counts.pages++;
  }

  // 5. Collect images from public/ and page references
  manifest.extract.images = collectImages(sourceDir, manifest.extract.contentFiles);
  manifest.extract.counts.images = manifest.extract.images.length;

  // 6. Detect next/* imports across all content files
  const componentAudit = auditNextImports(sourceDir, manifest.extract.contentFiles);
  manifest.extract.queries = componentAudit.map((a) => ({
    sourceFile: a.file,
    nodeType: a.component,
    fields: a.props,
    resolved: a.resolved,
  }));
  manifest.extract.counts.queries = componentAudit.filter((a) => !a.resolved).length;

  // 7. Derive tags and authors from frontmatter
  const meta = countMeta(manifest.extract.contentFiles, sourceDir);
  manifest.extract.counts.tags = meta.tags;
  manifest.extract.counts.authors = meta.authors;

  return { manifest, dryRun: opts.dryRun ?? false };
}

// ── next.config parsing ────────────────────────────────────────────────

interface NextConfigResult {
  hasMdx: boolean;
  imageDomains: string[];
  redirects: Array<{ source: string; destination: string; permanent: boolean }>;
  rewrites: Array<{ source: string; destination: string }>;
  env: Record<string, string>;
}

function parseNextConfig(sourceDir: string): NextConfigResult | null {
  const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
  let configPath: string | null = null;
  for (const f of configFiles) {
    const p = resolve(sourceDir, f);
    if (existsSync(p)) { configPath = p; break; }
  }
  if (!configPath) return null;

  const content = readFileSync(configPath, 'utf-8');
  const result: NextConfigResult = {
    hasMdx: content.includes('@next/mdx') || content.includes('withMDX'),
    imageDomains: [],
    redirects: [],
    rewrites: [],
    env: {},
  };

  // Extract images.domains
  const domainsMatch = content.match(/images\s*:\s*\{[^}]*domains\s*:\s*\[([^\]]*)\]/s);
  if (domainsMatch) {
    result.imageDomains = domainsMatch[1]
      .split(',')
      .map((d: string) => d.trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }

  // Detect redirects export
  if (content.includes('redirects')) {
    // Simplified: flag that redirects exist for the load phase
    const redirectMatches = content.matchAll(/source\s*:\s*['"]([^'"]+)['"]/g);
    for (const m of redirectMatches) {
      result.redirects.push({ source: m[1], destination: '', permanent: true });
    }
  }

  // Detect env
  const envMatch = content.match(/env\s*:\s*\{([^}]*)\}/s);
  if (envMatch) {
    const envPairs = envMatch[1].matchAll(/(\w+)\s*:\s*['"]([^'"]*)['"]/g);
    for (const m of envPairs) {
      result.env[m[1]] = m[2];
    }
  }

  return result;
}

// ── Content file collection ─────────────────────────────────────────────

function collectContentPages(sourceDir: string): ContentFile[] {
  const files: ContentFile[] = [];
  const pagesDir = resolve(sourceDir, 'pages');

  // Collect MDX and MD files
  const patterns = ['**/*.mdx', '**/*.md'];
  for (const pattern of patterns) {
    const entries = fg.sync(pattern, { cwd: pagesDir, absolute: true });
    for (const absPath of entries) {
      const rel = relative(pagesDir, absPath);
      // Skip _app, _document, _error, 404, api
      if (rel.startsWith('_') || rel.startsWith('api/') || rel === '404.mdx' || rel === '404.md') continue;

      const ext = extname(rel);
      const format = ext === '.mdx' ? 'mdx' as const : 'md' as const;
      const slug = deriveSlugFromPath(rel);
      const collection = classifyPage(rel);

      files.push({
        relativePath: `${collection}/${slug}${ext}`,
        absolutePath: absPath,
        checksum: checksumFile(absPath),
        format,
        collection,
      });
    }
  }

  return files;
}

function collectStaticPages(sourceDir: string): ContentFile[] {
  const files: ContentFile[] = [];
  const pagesDir = resolve(sourceDir, 'pages');

  // Collect JS/TS pages with getStaticProps (these are dynamic route templates)
  const patterns = ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'];
  for (const pattern of patterns) {
    const entries = fg.sync(pattern, { cwd: pagesDir, absolute: true });
    for (const absPath of entries) {
      const rel = relative(pagesDir, absPath);
      // Skip _app, _document, _error, 404, api
      if (rel.startsWith('_') || rel.startsWith('api/') || rel === '404.js' || rel === '404.tsx') continue;

      const content = readFileSync(absPath, 'utf-8');
      // Only include if it has getStaticProps (SSG page)
      if (!content.includes('getStaticProps') && !content.includes('getStaticPaths')) continue;

      const slug = deriveSlugFromPath(rel);
      const collection = classifyPage(rel);

      files.push({
        relativePath: `${collection}/${slug}.md`,
        absolutePath: absPath,
        checksum: checksumFile(absPath),
        format: 'md', // Will be converted from JS
        collection,
      });
    }
  }

  return files;
}

// ── Slug derivation from file path ─────────────────────────────────────

export function deriveSlugFromPath(pagePath: string): string {
  // pages/blog/[slug].mdx → first-post (filename-based slug)
  // pages/about.mdx → about
  // pages/index.mdx → index
  let slug = pagePath
    .replace(/\.[^.]+$/, '') // Remove extension
    .replace(/\[([^\]]+)\]/g, '$1') // [slug] → slug
    .replace(/\[\.\.\.([^\]]+)\]/g, '$1') // [...slug] → slug
    .replace(/\.{3}/g, ''); // Remove any remaining ... prefix

  // For nested paths, use just the last segment as the slug
  // blog/first-post → first-post (the blog prefix becomes the collection)
  const parts = slug.split('/');
  if (parts.length > 1) {
    // Keep the last segment as the slug
    slug = parts[parts.length - 1];
  }

  // Handle index files
  if (slug === 'index') {
    // If it's a nested index like blog/index → use the parent dir
    if (parts.length > 1) {
      slug = parts[parts.length - 2];
    } else {
      slug = 'index';
    }
  }

  return slug || 'index';
}

function classifyPage(pagePath: string): string {
  // pages/blog/[slug].mdx → blog
  // pages/about.mdx → pages
  // pages/index.mdx → pages
  const parts = pagePath.split('/');
  if (parts.length > 1) {
    const firstDir = parts[0];
    // If the first segment is a content directory (blog, posts, docs)
    if (['blog', 'posts', 'docs', 'news', 'articles'].includes(firstDir)) {
      return firstDir;
    }
  }
  return 'pages';
}

// ── Image collection ────────────────────────────────────────────────────

function collectImages(sourceDir: string, contentFiles: ContentFile[]): Manifest['extract']['images'] {
  const images: Manifest['extract']['images'] = [];
  const seen = new Set<string>();

  // 1. Walk public/ directory
  const publicDir = resolve(sourceDir, 'public');
  if (existsSync(publicDir)) {
    const imgPatterns = ['**/*.{jpg,jpeg,png,gif,webp,svg,avif}'];
    for (const pattern of imgPatterns) {
      const entries = fg.sync(pattern, { cwd: publicDir, absolute: true });
      for (const absPath of entries) {
        const rel = relative(publicDir, absPath);
        if (seen.has(rel)) continue;
        seen.add(rel);
        images.push({
          relativePath: rel,
          absolutePath: absPath,
          source: 'public',
        });
      }
    }
  }

  // 2. Scan content files for image references
  for (const f of contentFiles) {
    if (!existsSync(f.absolutePath)) continue;
    const content = readFileSync(f.absolutePath, 'utf-8');

    // next/image src="/path.jpg"
    const srcMatches = content.matchAll(/src=["']([^"']+\.(jpg|jpeg|png|gif|webp|svg|avif))["']/gi);
    for (const m of srcMatches) {
      const imgPath = m[1];
      if (imgPath.startsWith('http')) continue; // External
      const cleanPath = imgPath.replace(/^\//, '');
      if (seen.has(cleanPath)) continue;
      seen.add(cleanPath);
      images.push({
        relativePath: cleanPath,
        absolutePath: resolve(sourceDir, 'public', cleanPath),
        source: 'next/image',
      });
    }

    // ESM imports: import hero from "./hero.jpg"
    const importMatches = content.matchAll(/import\s+\w+\s+from\s+['"]([^'']+\.(jpg|jpeg|png|gif|webp|svg|avif))['"]/gi);
    for (const m of importMatches) {
      const imgPath = m[1];
      if (imgPath.startsWith('.')) {
        // Relative import — resolve from the file's directory
        const resolved = resolve(f.absolutePath, '..', imgPath);
        const rel = relative(sourceDir, resolved);
        if (seen.has(rel)) continue;
        seen.add(rel);
        images.push({
          relativePath: rel,
          absolutePath: resolved,
          source: 'src/images',
        });
      }
    }
  }

  return images;
}

// ── Next.js import audit ───────────────────────────────────────────────

interface ImportAuditEntry {
  file: string;
  component: string;
  props: string[];
  resolved: boolean;
}

function auditNextImports(sourceDir: string, contentFiles: ContentFile[]): ImportAuditEntry[] {
  const audit: ImportAuditEntry[] = [];
  const nextComponents: Record<string, { props: string[]; resolved: boolean }> = {
    'next/image': { props: ['src', 'width', 'height', 'alt', 'layout', 'objectFit', 'placeholder', 'priority', 'loader'], resolved: true },
    'next/link': { props: ['href', 'as', 'prefetch', 'replace', 'scroll', 'shallow', 'passHref'], resolved: true },
    'next/head': { props: [], resolved: true },
    'next/router': { props: ['useRouter', 'withRouter', 'Router'], resolved: false },
    'next/script': { props: ['src', 'strategy', 'onLoad'], resolved: true },
  };

  for (const f of contentFiles) {
    if (!existsSync(f.absolutePath)) continue;
    const content = readFileSync(f.absolutePath, 'utf-8');
    const rel = relative(sourceDir, f.absolutePath);

    for (const [mod, info] of Object.entries(nextComponents)) {
      if (content.includes(mod)) {
        audit.push({
          file: rel,
          component: mod,
          props: info.props.filter((p) => content.includes(p)),
          resolved: info.resolved,
        });
      }
    }
  }

  return audit;
}

// ── Plugin mapping ────────────────────────────────────────────────────

const PLUGIN_MAP: Record<string, { astroEquivalent: string | undefined; needsReview: boolean }> = {
  '@next/mdx':              { astroEquivalent: '@astrojs/mdx', needsReview: false },
  'next-mdx-remote':        { astroEquivalent: '@astrojs/mdx', needsReview: true },
  '@next/font':             { astroEquivalent: 'astro:assets', needsReview: false },
  'next-sitemap':           { astroEquivalent: '@astrojs/sitemap', needsReview: false },
  'next-seo':               { astroEquivalent: 'Astro SEO', needsReview: true },
  'next-google-analytics':  { astroEquivalent: '@astrojs/partytown', needsReview: true },
  'next-feed':              { astroEquivalent: '@astrojs/rss', needsReview: false },
  'gray-matter':            { astroEquivalent: 'built-in', needsReview: false },
  'remark':                 { astroEquivalent: 'built-in', needsReview: false },
  'rehype':                 { astroEquivalent: 'built-in', needsReview: false },
};

function mapPlugins(config: NextConfigResult): PluginMapping[] {
  const plugins: PluginMapping[] = [];

  if (config.hasMdx) {
    const mapping = PLUGIN_MAP['@next/mdx'];
    plugins.push({
      gatsbyPlugin: '@next/mdx', // Reuse schema field name
      astroEquivalent: mapping.astroEquivalent,
      needsReview: mapping.needsReview,
    });
  }

  if (config.imageDomains.length > 0) {
    plugins.push({
      gatsbyPlugin: 'next/image (external domains)',
      astroEquivalent: '@astrojs/assets',
      needsReview: true,
      options: { domains: config.imageDomains },
    });
  }

  if (config.redirects.length > 0) {
    plugins.push({
      gatsbyPlugin: 'next.config redirects',
      astroEquivalent: 'Astro redirects',
      needsReview: false,
    });
  }

  // Always add sitemap and RSS as recommended
  plugins.push({
    gatsbyPlugin: 'next-sitemap (recommended)',
    astroEquivalent: '@astrojs/sitemap',
    needsReview: false,
  });

  return plugins;
}

// ── Plugin registry ─────────────────────────────────────────────────────

const REGISTRY: Record<string, { astroEquivalent: string | undefined; needsReview: boolean }> = {
  ...PLUGIN_MAP,
  'next/image':             { astroEquivalent: 'astro:assets', needsReview: true },
  'next/link':               { astroEquivalent: '<a>', needsReview: false },
  'next/head':               { astroEquivalent: 'Astro <head>', needsReview: false },
  'next/router':             { astroEquivalent: undefined, needsReview: true },
  'next/script':             { astroEquivalent: '<script>', needsReview: true },
};

export interface NextPluginRegistryResult { mapped: number; unmapped: string[] }

export function mapNextPluginsToAstro(plugins: PluginMapping[]): NextPluginRegistryResult {
  let mapped = 0;
  const unmapped: string[] = [];
  for (const plugin of plugins) {
    const entry = REGISTRY[plugin.gatsbyPlugin];
    if (entry) {
      plugin.astroEquivalent = entry.astroEquivalent;
      plugin.needsReview = entry.needsReview;
      if (!entry.needsReview) mapped++;
      else unmapped.push(plugin.gatsbyPlugin);
    } else {
      unmapped.push(plugin.gatsbyPlugin);
    }
  }
  return { mapped, unmapped };
}

// ── Field mapping ──────────────────────────────────────────────────────

export const NEXT_FIELD_KEY_MAP: Record<string, string> = {
  title: 'title',
  date: 'pubDate',
  tags: 'tags',
  author: 'authors',
  excerpt: 'description',
  description: 'description',
  draft: 'draft',
  heroImage: 'heroImage',
  slug: '_slug',
  category: 'categories',
  categories: 'categories',
};

// ── Next.js transform ───────────────────────────────────────────────────

export interface NextTransformResult {
  mapped: number;
  rewrites: Array<{ file: string; type: 'link' | 'image' | 'plugin' | 'fragment' | 'other'; from: string; to: string }>;
}

export function transformNextContent(manifest: Manifest): NextTransformResult {
  let mapped = 0;
  const rewrites: NextTransformResult['rewrites'] = [];
  const sourceDir = manifest.source.path;

  for (const file of manifest.extract.contentFiles) {
    if (!existsSync(file.absolutePath)) continue;
    const content = readFileSync(file.absolutePath, 'utf-8');
    const rel = relative(sourceDir, file.absolutePath);

    // Count mapped frontmatter fields
    const split = splitFrontmatter(content);
    if (split && split.frontmatter) {
      const fmData = split.frontmatter as Record<string, unknown>;
      for (const [key] of Object.entries(NEXT_FIELD_KEY_MAP)) {
        if (fmData[key] !== undefined) mapped++;
      }
    }

    // Track next/link rewrites
    if (content.includes('next/link') || content.includes('<Link')) {
      rewrites.push({ file: rel, type: 'link', from: 'next/link', to: '<a>' });
    }

    // Track next/image rewrites
    if (content.includes('next/image') || content.includes('<Image')) {
      rewrites.push({ file: rel, type: 'image', from: 'next/image', to: 'astro:assets' });
    }

    // Track next/head rewrites
    if (content.includes('next/head') || content.includes('<Head')) {
      rewrites.push({ file: rel, type: 'other', from: 'next/head', to: 'Astro <head>' });
    }

    // Track getStaticProps extraction
    if (content.includes('getStaticProps')) {
      rewrites.push({ file: rel, type: 'other', from: 'getStaticProps', to: 'frontmatter' });
    }
  }

  return { mapped, rewrites };
}

// ── Slug derivation ─────────────────────────────────────────────────────

export function deriveSlug(absolutePath: string, sourceDir: string): string {
  const pagesDir = resolve(sourceDir, 'pages');
  const rel = relative(pagesDir, absolutePath);
  return deriveSlugFromPath(rel);
}

// ── Component rewrites (used by astro-writer) ───────────────────────────

export function rewriteNextLink(content: string): string {
  // Replace <Link href="/path">text</Link> with <a href="/path">text</a>
  return content
    .replace(/<Link\s+href=["']([^"']+)["']([^>]*)>/gi, '<a href="$1"$2>')
    .replace(/<\/Link>/gi, '</a>')
    .replace(/import\s+\w+\s+from\s+['"]next\/link['"];?\n?/gi, '');
}

export function rewriteNextImage(content: string): string {
  // Replace <Image src="/path.jpg" width={800} height={600} alt="..." /> with Astro <Image />
  // Note: This is a simplified rewrite. Full prop mapping needs manual review.
  return content
    .replace(/import\s+\w+\s+from\s+['"]next\/image['"];?\n?/gi, '')
    .replace(/<Image\s+/g, '<Image ');
}

export function rewriteNextHead(content: string): string {
  return content
    .replace(/import\s+\w+\s+from\s+['"]next\/head['"];?\n?/gi, '')
    .replace(/<Head>/gi, '')
    .replace(/<\/Head>/gi, '');
}

// ── Frontmatter mapping (used by astro-writer) ──────────────────────────

export function mapNextFrontmatter(rawFrontmatter: Record<string, unknown>): Record<string, unknown> {
  const astro: Record<string, unknown> = {};

  if (rawFrontmatter.title) astro.title = String(rawFrontmatter.title);

  if (rawFrontmatter.date) {
    const d = coerceDate(String(rawFrontmatter.date));
    if (d) astro.pubDate = d;
  }

  if (rawFrontmatter.tags) astro.tags = ensureArray(rawFrontmatter.tags);
  if (rawFrontmatter.categories || rawFrontmatter.category) {
    astro.categories = ensureArray(rawFrontmatter.categories || rawFrontmatter.category);
  }

  if (rawFrontmatter.author) {
    astro.authors = ensureArray(rawFrontmatter.author);
  } else if (rawFrontmatter.authors) {
    astro.authors = ensureArray(rawFrontmatter.authors);
  }

  if (rawFrontmatter.excerpt) astro.description = String(rawFrontmatter.excerpt);
  else if (rawFrontmatter.description) astro.description = String(rawFrontmatter.description);

  if (rawFrontmatter.draft !== undefined) {
    astro.draft = coerceBoolean(rawFrontmatter.draft);
  }

  if (rawFrontmatter.heroImage) {
    astro.heroImage = rewriteImagePath(String(rawFrontmatter.heroImage));
  }

  return astro;
}

function rewriteImagePath(imagePath: string): string {
  if (imagePath.startsWith('/')) {
    // public/ reference → relative path
    return `../../assets/${imagePath.replace(/^\//, '')}`;
  }
  if (imagePath.startsWith('./') || imagePath.startsWith('../')) {
    return `../../assets/blog/${basename(imagePath)}`;
  }
  return imagePath;
}

// ── Meta counting ───────────────────────────────────────────────────────

function countMeta(contentFiles: ContentFile[], _sourceDir: string): { tags: number; authors: number } {
  const tagSet = new Set<string>();
  const authorSet = new Set<string>();

  for (const f of contentFiles) {
    if (!existsSync(f.absolutePath)) continue;
    // Skip JS/TS files that don't have YAML frontmatter
    const ext = extname(f.absolutePath);
    if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') continue;

    const content = readFileSync(f.absolutePath, 'utf-8');
    const split = splitFrontmatter(content);
    if (!split || !split.frontmatter) continue;
    const fmData = split.frontmatter as Record<string, unknown>;

    if (fmData.tags) {
      for (const t of ensureArray(fmData.tags)) tagSet.add(String(t));
    }
    if (fmData.categories) {
      for (const c of ensureArray(fmData.categories)) tagSet.add(String(c));
    }
    if (fmData.author) authorSet.add(String(fmData.author));
    if (fmData.authors) {
      for (const a of ensureArray(fmData.authors)) authorSet.add(String(a));
    }
  }

  return { tags: tagSet.size, authors: authorSet.size };
}
