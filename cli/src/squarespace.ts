/**
 * Squarespace project reader: HTML-to-Markdown conversion, CDN image
 * collection, hero derivation, crawl fallback, and field mapping.
 * Owns everything about *reading* a Squarespace export.
 *
 * WXR XML parsing is delegated to the shared wxr-parser.ts library,
 * which is also used by the future wordpress2astro route.
 * See cli/docs/adr/001-wxr-parser.md for the architectural decision.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { Manifest, PluginMapping } from './manifest.js';
import { coerceDate } from './frontmatter.js';
import { parseWxr, wxrSlugify, type WxrItem, type WxrChannelInfo } from './wxr-parser.js';
import { checksumString, downloadImage, downloadAllRemoteImages, sqspUrlTransform, sqspFilenameTransform } from './asset_handler.js';
import { convertHtmlToMarkdown as sharedConvertHtmlToMarkdown } from './block_parser.js';

// Re-export WXR types for consumers that import from squarespace.ts
export type { WxrItem, WxrChannelInfo } from './wxr-parser.js';

// ── Public API ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  export: string;
  to: string;
  crawl?: string;
  routeBase?: string;
  hero?: 'first-image' | 'none';
  dryRun?: boolean;
  includeDrafts?: boolean;
}

export interface ExtractResult {
  manifest: Manifest;
  dryRun: boolean;
  wxrItems: WxrItem[];
}

export async function extractSquarespace(opts: ExtractOptions): Promise<ExtractResult> {
  const exportPath = resolve(opts.export);

  if (!existsSync(exportPath)) {
    throw new Error(`Export file not found: ${exportPath}`);
  }

  const manifest: Manifest = {
    version: '1',
    source: { platform: 'squarespace', path: exportPath },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };

  // 1. Parse WXR via shared parser
  const xmlContent = readFileSync(exportPath, 'utf-8');
  const wxrResult = parseWxr(xmlContent);

  // 2. Convert WXR items to ContentFiles
  for (const item of wxrResult.items) {
    const collection = item.postType === 'page' ? 'pages' : 'blog';
    const slug = item.postName || wxrSlugify(item.title);

    manifest.extract.contentFiles.push({
      relativePath: `${collection}/${slug}.md`,
      absolutePath: '', // WXR items don't have filesystem paths
      checksum: checksumString(item.content),
      format: 'md',
      collection,
    });
  }

  // 3. Count posts vs pages
  for (const f of manifest.extract.contentFiles) {
    if (f.collection === 'blog') manifest.extract.counts.posts++;
    else if (f.collection === 'pages') manifest.extract.counts.pages++;
  }

  // 4. Collect CDN images
  manifest.extract.images = extractImages(xmlContent);
  manifest.extract.counts.images = manifest.extract.images.length;

  // 5. Map features (Squarespace has no plugin system, but has feature equivalents)
  manifest.extract.plugins = mapFeatures(wxrResult.channelInfo);
  manifest.extract.counts.plugins = manifest.extract.plugins.length;

  // 6. Derive tags and authors
  const meta = countMeta(wxrResult.items);
  manifest.extract.counts.tags = meta.tags;
  manifest.extract.counts.authors = meta.authors;

  return { manifest, dryRun: opts.dryRun ?? false, wxrItems: wxrResult.items };
}

// ── WXR items sidecar (for load phase) ────────────────────────────────

export function writeWxrItems(items: WxrItem[], targetDir: string): void {
  const path = resolve(targetDir, 'portage-wxr-items.json');
  mkdirSync(resolve(targetDir), { recursive: true });
  writeFileSync(path, JSON.stringify(items, null, 2) + '\n', 'utf-8');
}

export function readWxrItems(targetDir: string): WxrItem[] {
  const path = resolve(targetDir, 'portage-wxr-items.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── CDN image download ────────────────────────────────────────────────

export const SQSP_CDN_BASE = 'images.squarespace-cdn.com';

/**
 * Squarespace CDN images are public static URLs that require no authentication.
 * After site deletion, images persist for 8-38 days on the CDN.
 *
 * URL format: https://images.squarespace-cdn.com/content/<site_id>/<image_id>/<filename>?format=<variant>
 * Size variants: 100w, 300w, 500w, 750w, 1000w, 1500w, 2500w
 * There is no "original" format; 2500w is the largest available.
 *
 * Download strategy:
 *   1. Strip ?format= query param from URLs found in the WXR
 *   2. Re-request with ?format=2500w for maximum quality
 *   3. Save to src/assets/blog/<filename>
 *   4. Rewrite body image references from CDN URLs to relative paths
 *   5. Report any download failures (image may have expired from CDN)
 */
export async function downloadCdnImage(url: string, targetDir: string): Promise<{ success: boolean; localPath: string; error?: string }> {
  return downloadImage({
    url,
    targetDir,
    subdir: 'src/assets/blog',
    urlTransform: sqspUrlTransform,
    filenameTransform: sqspFilenameTransform,
  });
}

export async function downloadAllCdnImages(manifest: Manifest, targetDir: string, dryRun: boolean): Promise<{ downloaded: number; skipped: number; failed: number; errors: string[] }> {
  return downloadAllRemoteImages(manifest, targetDir, dryRun, 'src/assets/blog', sqspUrlTransform, sqspFilenameTransform);
}

// ── HTML to Markdown conversion (delegates to block_parser) ────────────

export function convertHtmlToMarkdown(html: string): string {
  return sharedConvertHtmlToMarkdown(html, 'squarespace');
}

// ── Image extraction ────────────────────────────────────────────────────

export function extractImages(xmlContent: string): Manifest['extract']['images'] {
  const images: Manifest['extract']['images'] = [];
  const seen = new Set<string>();

  const imgRe = /https:\/\/images\.squarespace-cdn\.com\/[^\s"'<>]+/g;
  let match: RegExpExecArray | null;

  while ((match = imgRe.exec(xmlContent)) !== null) {
    let url = match[0];
    url = url.replace(/\?format=\w+$/, '').replace(/\?.*$/, '');
    if (seen.has(url)) continue;
    seen.add(url);

    const filename = basename(new URL(url).pathname);
    images.push({
      relativePath: filename,
      absolutePath: url,
      source: 'remote',
    });
  }

  return images;
}

// ── Hero derivation ─────────────────────────────────────────────────────

export function deriveHero(html: string): string | null {
  const imgMatch = html.match(/<img[^>]+src="([^"]+)"/);
  if (!imgMatch) return null;
  let url = imgMatch[1];
  url = url.replace(/\?format=\w+$/, '');
  return url;
}

// ── Feature mapping ────────────────────────────────────────────────────

const FEATURE_MAP: Record<string, { equivalent: string | undefined; needsReview: boolean }> = {
  'blog':          { equivalent: '@astrojs/rss', needsReview: false },
  'sitemap':       { equivalent: '@astrojs/sitemap', needsReview: false },
  'url-mappings':  { equivalent: 'redirect map', needsReview: false },
  'gallery-block': { equivalent: 'image sequence', needsReview: true },
  'summary-block': { equivalent: 'link list (manual)', needsReview: true },
  'form-block':    { equivalent: undefined, needsReview: true },
  'store-page':    { equivalent: undefined, needsReview: true },
  'events-page':   { equivalent: undefined, needsReview: true },
  'portfolio-page':{ equivalent: undefined, needsReview: true },
};

function mapFeatures(_channelInfo: WxrChannelInfo): PluginMapping[] {
  const features = ['blog', 'sitemap', 'url-mappings'];
  return features.map((f) => {
    const mapping = FEATURE_MAP[f];
    return {
      gatsbyPlugin: f,
      astroEquivalent: mapping?.equivalent,
      options: undefined,
      needsReview: mapping?.needsReview ?? true,
    };
  });
}

// ── Plugin registry ────────────────────────────────────────────────────

const REGISTRY: Record<string, { astroEquivalent: string | undefined; needsReview: boolean }> = {
  'blog':          { astroEquivalent: '@astrojs/rss', needsReview: false },
  'sitemap':       { astroEquivalent: '@astrojs/sitemap', needsReview: false },
  'url-mappings':  { astroEquivalent: 'redirect map', needsReview: false },
  'gallery-block': { astroEquivalent: 'image sequence', needsReview: true },
  'summary-block': { astroEquivalent: 'link list (manual)', needsReview: true },
  'form-block':    { astroEquivalent: undefined, needsReview: true },
  'store-page':    { astroEquivalent: undefined, needsReview: true },
  'events-page':   { astroEquivalent: undefined, needsReview: true },
  'portfolio-page':{ astroEquivalent: undefined, needsReview: true },
};

export interface SquarespacePluginRegistryResult { mapped: number; unmapped: string[] }

export function mapSquarespaceFeaturesToAstro(plugins: PluginMapping[]): SquarespacePluginRegistryResult {
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

export const SQUARESPACE_FIELD_KEY_MAP: Record<string, string> = {
  title: 'title',
  postName: '_slug',
  excerpt: 'description',
  pubDate: 'pubDate',
  postDate: 'pubDate',
  tags: 'tags',
  categories: 'categories',
  creator: 'authors',
  status: 'draft',
  link: '_link',
};

// ── Squarespace transform ────────────────────────────────────────────────

export interface SquarespaceTransformResult {
  mapped: number;
  rewrites: Array<{ file: string; type: 'link' | 'image' | 'plugin' | 'fragment' | 'other'; from: string; to: string }>;
}

export function transformSquarespaceContent(items: WxrItem[]): SquarespaceTransformResult {
  let mapped = 0;
  const rewrites: SquarespaceTransformResult['rewrites'] = [];

  for (const item of items) {
    for (const [key] of Object.entries(SQUARESPACE_FIELD_KEY_MAP)) {
      if ((item as unknown as Record<string, unknown>)[key] !== undefined) {
        mapped++;
      }
    }

    if (item.content && item.content.includes('<')) {
      rewrites.push({ file: item.postName || item.title, type: 'other', from: 'HTML body', to: 'Markdown' });
    }

    if (item.content && item.content.includes('images.squarespace-cdn.com')) {
      rewrites.push({ file: item.postName || item.title, type: 'image', from: 'CDN image', to: 'local path' });
    }
  }

  return { mapped, rewrites };
}

// ── Slug derivation (delegates to shared wxrSlugify) ────────────────────

export function deriveSlug(item: WxrItem): string {
  if (item.postName) return item.postName;
  return wxrSlugify(item.title);
}

export function slugify(text: string): string {
  return wxrSlugify(text);
}

// ── Meta counting ───────────────────────────────────────────────────────

function countMeta(items: WxrItem[]): { tags: number; authors: number } {
  const tagSet = new Set<string>();
  const authorSet = new Set<string>();
  for (const item of items) {
    for (const t of item.tags) tagSet.add(t);
    for (const c of item.categories) tagSet.add(c);
    if (item.creator) authorSet.add(item.creator);
  }
  return { tags: tagSet.size, authors: authorSet.size };
}

// ── Helpers ─────────────────────────────────────────────────────────────

// ── Squarespace frontmatter mapping ────────────────────────────────────

export function mapSquarespaceFrontmatter(item: WxrItem, heroStrategy: 'first-image' | 'none'): Record<string, unknown> {
  const astro: Record<string, unknown> = {};

  astro.title = item.title;
  if (item.excerpt) {
    astro.description = item.excerpt.replace(/<[^>]+>/g, '').trim();
  }

  const dateVal = coerceDate(item.pubDate || item.postDate);
  if (dateVal) astro.pubDate = dateVal;

  if (item.tags.length > 0) astro.tags = item.tags;
  if (item.categories.length > 0) astro.categories = item.categories;
  if (item.creator) astro.authors = [item.creator];

  if (item.status === 'draft') astro.draft = true;
  else astro.draft = false;

  if (heroStrategy === 'first-image') {
    const heroUrl = deriveHero(item.content);
    if (heroUrl) {
      const filename = basename(new URL(heroUrl).pathname);
      astro.heroImage = `../../assets/blog/${filename}`;
    }
  }

  if (item.link) astro.squarespaceLink = item.link;

  return astro;
}
