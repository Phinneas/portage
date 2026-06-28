/**
 * Substack export reader: ZIP extraction, CSV parsing, HTML body correlation,
 * CDN image collection, mention conversion, subscribe-button stripping, and
 * field mapping. Owns everything about *reading* a Substack export.
 *
 * The ZIP structure is:
 *   posts.csv            — metadata (post_id, title, subtitle, url, post_date, …)
 *   posts/               — one HTML file per post ({post_id}.{slug}.html)
 *
 * Portage unzips the archive, parses the CSV, reads each HTML file,
 * and joins them by post_id to produce a unified manifest.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import type { Manifest, PluginMapping } from './manifest.js';
import { coerceDate } from './frontmatter.js';
import { checksumString, downloadImage, downloadAllRemoteImages, substackUrlTransform, substackFilenameTransform } from './asset_handler.js';
import TurndownService from 'turndown';

// ── Types ───────────────────────────────────────────────────────────────

export interface SubstackPost {
  postId: string;
  slug: string;
  title: string;
  subtitle: string;
  url: string;
  postDate: string;
  isPublished: boolean;
  audience: 'public' | 'only_free' | 'only_paid';
  type: 'newsletter' | 'page' | 'podcast' | 'thread';
  audioUrl: string;
  podcastDuration: number;
  podcastUrl: string;
  html: string;
}

export interface ExtractOptions {
  export: string;
  to: string;
  url?: string;
  crawl?: string;
  routeBase?: string;
  hero?: 'og-image' | 'first-image' | 'none';
  dryRun?: boolean;
  includeDrafts?: boolean;
  includeThreads?: boolean;
}

export interface ExtractResult {
  manifest: Manifest;
  dryRun: boolean;
  posts: SubstackPost[];
}

// ── CSV Parsing ─────────────────────────────────────────────────────────

export function parseCsv(csvText: string): Record<string, string>[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length && j < values.length; j++) {
      row[headers[j].trim()] = values[j].trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ── ZIP Extraction ───────────────────────────────────────────────────────

/**
 * Reads a Substack ZIP export and returns the CSV text and HTML files.
 * Uses Node's built-in zlib to decompress the ZIP.
 * For simplicity, delegates to the `adm-zip`-like approach using
 * a temporary directory extraction.
 */
export function readSubstackZip(zipPath: string): { csv: string; htmlFiles: Map<string, string> } {
  const htmlFiles = new Map<string, string>(); // post_id → html content
  let csv = '';

  // Use the system's unzip command for cross-platform compatibility
  // Or parse directly if it's already extracted
  const dir = extractZipToTemp(zipPath);

  // Read posts.csv
  const csvPath = findFile(dir, 'posts.csv');
  if (csvPath) {
    csv = readFileSync(csvPath, 'utf-8');
  }

  // Read all HTML files in posts/ directory
  const postsDir = join(dir, 'posts');
  if (existsSync(postsDir)) {
    for (const entry of readdirSync(postsDir)) {
      if (entry.endsWith('.html')) {
        const postId = entry.replace(/\.html$/, '');
        const html = readFileSync(join(postsDir, entry), 'utf-8');
        htmlFiles.set(postId, html);
      }
    }
  } else {
    // HTML files might be at the root level (some export variations)
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.html')) {
        const postId = entry.replace(/\.html$/, '');
        const html = readFileSync(join(dir, entry), 'utf-8');
        htmlFiles.set(postId, html);
      }
    }
  }

  return { csv, htmlFiles };
}

function extractZipToTemp(zipPath: string): string {
  const os = require('node:os');
  const tmpDir = join(os.tmpdir(), `portage-substack-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Use the system's unzip utility
  const { execSync } = require('node:child_process');
  try {
    execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
  } catch {
    throw new Error(`Failed to extract ZIP file: ${zipPath}. Ensure 'unzip' is available on the system.`);
  }

  return tmpDir;
}

function findFile(dir: string, filename: string): string | null {
  // Check root level
  const rootPath = join(dir, filename);
  if (existsSync(rootPath)) return rootPath;

  // Check one level deep (some exports nest)
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nestedPath = join(dir, entry.name, filename);
        if (existsSync(nestedPath)) return nestedPath;
      }
    }
  } catch { /* ignore */ }

  return null;
}

// ── Main Extraction ─────────────────────────────────────────────────────

export async function extractSubstack(opts: ExtractOptions): Promise<ExtractResult> {
  const exportPath = resolve(opts.export);

  if (!existsSync(exportPath)) {
    throw new Error(`Export file not found: ${exportPath}`);
  }

  const manifest: Manifest = {
    version: '1',
    source: { platform: 'substack', path: exportPath },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };

  // 1. Read ZIP contents
  const { csv, htmlFiles } = readSubstackZip(exportPath);

  // 2. Parse CSV for metadata
  const csvRows = parseCsv(csv);

  // 3. Join CSV rows with HTML files by post_id
  const posts: SubstackPost[] = [];
  const gaps: string[] = [];

  for (const row of csvRows) {
    const postId = row.post_id || '';
    const html = htmlFiles.get(postId);

    if (!html) {
      gaps.push(postId);
      continue; // Skip posts without HTML (Ghost migrator applies same rule)
    }

    // Derive slug from HTML filename: {post_id}.{slug}.html
    const slugFromFilename = deriveSlugFromPostId(postId);

    const post: SubstackPost = {
      postId,
      slug: slugFromFilename || row.url?.split('/').pop() || postId.replace(/^\d+\./, ''),
      title: row.title || slugFromFilename || postId,
      subtitle: row.subtitle || '',
      url: row.url || '',
      postDate: row.post_date || '',
      isPublished: (row.is_published || 'true').toLowerCase() === 'true',
      audience: row.audience === 'only_paid' ? 'only_paid' : row.audience === 'only_free' ? 'only_free' : 'public',
      type: (['newsletter', 'page', 'podcast', 'thread'].includes(row.type?.toLowerCase()) ? row.type.toLowerCase() : 'newsletter') as SubstackPost['type'],
      audioUrl: row.audio_url || '',
      podcastDuration: row.podcast_duration ? parseInt(row.podcast_duration, 10) : 0,
      podcastUrl: row.podcast_url || '',
      html,
    };

    // Filter by options
    if (!opts.includeDrafts && !post.isPublished) continue;
    if (!opts.includeThreads && post.type === 'thread') continue;

    posts.push(post);
  }

  // Handle HTML files without CSV rows (orphaned)
  for (const [postId, html] of htmlFiles) {
    if (!csvRows.some((r) => r.post_id === postId)) {
      const slug = deriveSlugFromPostId(postId);
      posts.push({
        postId,
        slug: slug || postId,
        title: slug || postId,
        subtitle: '',
        url: '',
        postDate: '',
        isPublished: true,
        audience: 'public',
        type: 'newsletter',
        audioUrl: '',
        podcastDuration: 0,
        podcastUrl: '',
        html,
      });
    }
  }

  // Sort chronologically
  posts.sort((a, b) => {
    const da = new Date(a.postDate || 0).getTime();
    const db = new Date(b.postDate || 0).getTime();
    return da - db || parseInt(a.postId) - parseInt(b.postId);
  });

  // 4. Convert posts to ContentFiles
  for (const post of posts) {
    const collection = mapTypeToCollection(post.type);
    manifest.extract.contentFiles.push({
      relativePath: `${collection}/${post.slug}.md`,
      absolutePath: '', // ZIP items don't have filesystem paths
      checksum: checksumString(post.html),
      format: 'md',
      collection,
    });
  }

  // 5. Count by collection
  for (const f of manifest.extract.contentFiles) {
    if (f.collection === 'blog') manifest.extract.counts.posts++;
    else if (f.collection === 'pages') manifest.extract.counts.pages++;
  }

  // 6. Extract images from all HTML bodies
  manifest.extract.images = extractSubstackImages(posts);
  manifest.extract.counts.images = manifest.extract.images.length;

  // 7. Map features
  manifest.extract.plugins = mapFeatures();
  manifest.extract.counts.plugins = manifest.extract.plugins.length;

  return { manifest, dryRun: opts.dryRun ?? false, posts };
}

// ── Slug derivation ─────────────────────────────────────────────────────

export function deriveSlugFromPostId(postId: string): string {
  // postId format: "12345.my-post-slug" → "my-post-slug"
  const dotIndex = postId.indexOf('.');
  if (dotIndex === -1) return postId;
  return postId.slice(dotIndex + 1);
}

function mapTypeToCollection(type: SubstackPost['type']): string {
  switch (type) {
    case 'page': return 'pages';
    case 'podcast': return 'podcast';
    case 'thread': return 'threads';
    default: return 'blog';
  }
}

// ── HTML to Markdown conversion ─────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Rule: Convert Substack mention spans to @name text
turndown.addRule('mentionWrap', {
  filter: (node) => {
    if (node.nodeName === 'SPAN') {
      const cls = node.getAttribute('class') || '';
      return cls.includes('mention-wrap');
    }
    return false;
  },
  replacement: (_content, node) => {
    const attrs = node.getAttribute('data-attrs');
    if (attrs) {
      try {
        const parsed = JSON.parse(attrs.replace(/&quot;/g, '"'));
        if (parsed.name) return `@${parsed.name}`;
      } catch { /* fall through */ }
    }
    return _content.trim();
  },
});

// Rule: Strip subscribe widgets
turndown.addRule('subscribeWidget', {
  filter: (node) => {
    if (node.nodeName === 'DIV') {
      const cls = node.getAttribute('class') || '';
      return cls.includes('subscribe-widget') || cls.includes('subscription-widget');
    }
    return false;
  },
  replacement: () => '',
});

// Rule: Strip inline style attributes (keep semantic markup)
turndown.addRule('stripInlineStyle', {
  filter: (node) => {
    return node.getAttribute && node.getAttribute('style') !== null && node.getAttribute('style') !== '';
  },
  replacement: (content) => content,
});

export function convertHtmlToMarkdown(html: string): string {
  if (!html || !html.includes('<')) return html;

  // Pre-turndown cleanup
  let cleaned = html
    // Remove subscribe button containers
    .replace(/<div\s+class="[^"]*subscribe-widget[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div\s+class="[^"]*subscription-widget[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Remove inline styles (preserve element structure)
    .replace(/\s+style="[^"]*"/g, '')
    // Remove Substack-specific class attributes
    .replace(/\s+class="[^"]*substack[^"]*"/g, '')
    // Remove data-attrs from non-mention spans (cleanup)
    .replace(/<span\s+class="mention-wrap"\s+data-attrs="([^"]*)">/g, (_, attrs) => {
      return `<span class="mention-wrap" data-attrs="${attrs}">`;
    });

  return turndown.turndown(cleaned);
}

// ── Mention extraction ──────────────────────────────────────────────────

export function extractMentions(html: string): string[] {
  const mentions: string[] = [];
  const re = /class="mention-wrap"\s+data-attrs="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    try {
      const decoded = match[1].replace(/&quot;/g, '"');
      const parsed = JSON.parse(decoded);
      if (parsed.name) mentions.push(parsed.name);
    } catch { /* skip malformed */ }
  }
  return mentions;
}

// ── Image extraction ─────────────────────────────────────────────────────

export const SUBSTACK_CDN_PATTERNS = [
  'substackcdn.com',
  'substack-post-media.s3.amazonaws.com',
];

export function extractSubstackImages(posts: SubstackPost[]): Manifest['extract']['images'] {
  const images: Manifest['extract']['images'] = [];
  const seen = new Set<string>();

  for (const post of posts) {
    const imgRe = /https:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp|svg)[^\s"'<>)]*/gi;
    let match: RegExpExecArray | null;

    while ((match = imgRe.exec(post.html)) !== null) {
      let url = match[0];
      // Only collect Substack CDN images
      if (!SUBSTACK_CDN_PATTERNS.some((p) => url.includes(p))) continue;

      // Strip resize parameters for deduplication key
      const bareUrl = url.replace(/\?.*$/, '');
      if (seen.has(bareUrl)) continue;
      seen.add(bareUrl);

      const filename = deriveImageFilename(bareUrl);
      images.push({
        relativePath: filename,
        absolutePath: url,
        source: 'remote',
      });
    }
  }

  return images;
}

function deriveImageFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    // For CDN proxy URLs, the actual filename is URL-encoded in the path
    // e.g., .../https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F{uuid}_{size}.ext
    const decoded = decodeURIComponent(pathname);
    const filename = basename(decoded);
    // Strip size suffix like _800x600 or _1000x
    return filename.replace(/_\d+x\d*(?=\.\w+$)/, '').replace(/_\d+w(?=\.\w+$)/, '');
  } catch {
    return basename(url);
  }
}

// ── CDN image download (delegates to asset_handler) ──────────────────

export async function downloadCdnImage(url: string, targetDir: string): Promise<{ success: boolean; localPath: string; error?: string }> {
  return downloadImage({
    url,
    targetDir,
    subdir: 'src/assets/blog',
    urlTransform: substackUrlTransform,
    filenameTransform: substackFilenameTransform,
  });
}

export async function downloadAllCdnImages(
  manifest: Manifest,
  targetDir: string,
  dryRun: boolean
): Promise<{ downloaded: number; skipped: number; failed: number; errors: string[] }> {
  return downloadAllRemoteImages(manifest, targetDir, dryRun, 'src/assets/blog', substackUrlTransform, substackFilenameTransform);
}

// ── Hero derivation ────────────────────────────────────────────────────

export function deriveHero(html: string): string | null {
  const imgMatch = html.match(/<img[^>]+src="([^"]+)"/);
  if (!imgMatch) return null;
  const url = imgMatch[1];
  // Only return if it's a Substack CDN image
  if (!SUBSTACK_CDN_PATTERNS.some((p) => url.includes(p))) return null;
  return url;
}

// ── Feature mapping ────────────────────────────────────────────────────

function mapFeatures(): PluginMapping[] {
  return [
    { gatsbyPlugin: 'blog', astroEquivalent: '@astrojs/rss', options: undefined, needsReview: false },
    { gatsbyPlugin: 'sitemap', astroEquivalent: '@astrojs/sitemap', options: undefined, needsReview: false },
    { gatsbyPlugin: 'subscribe-buttons', astroEquivalent: undefined, options: undefined, needsReview: true },
    { gatsbyPlugin: 'podcast', astroEquivalent: undefined, options: undefined, needsReview: true },
  ];
}

// ── Plugin registry ────────────────────────────────────────────────────

const REGISTRY: Record<string, { astroEquivalent: string | undefined; needsReview: boolean }> = {
  'blog':               { astroEquivalent: '@astrojs/rss', needsReview: false },
  'sitemap':            { astroEquivalent: '@astrojs/sitemap', needsReview: false },
  'subscribe-buttons':   { astroEquivalent: undefined, needsReview: true },
  'podcast':            { astroEquivalent: undefined, needsReview: true },
};

export interface PluginRegistryResult { mapped: number; unmapped: string[] }

export function mapSubstackFeaturesToAstro(plugins: PluginMapping[]): PluginRegistryResult {
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

export const SUBSTACK_FIELD_KEY_MAP: Record<string, string> = {
  title: 'title',
  subtitle: 'description',
  postDate: 'pubDate',
  isPublished: 'draft',
  audience: 'access',
  url: 'canonicalURL',
  audioUrl: 'audioUrl',
  podcastDuration: 'audioDuration',
};

// ── Frontmatter mapping ─────────────────────────────────────────────────

export function mapSubstackFrontmatter(
  post: SubstackPost,
  heroStrategy: 'og-image' | 'first-image' | 'none'
): Record<string, unknown> {
  const astro: Record<string, unknown> = {};

  astro.title = post.title;
  if (post.subtitle) astro.description = post.subtitle;

  const dateVal = coerceDate(post.postDate);
  if (dateVal) astro.pubDate = dateVal;

  astro.draft = !post.isPublished;

  if (post.audience === 'only_paid') astro.access = 'paid';
  else if (post.audience === 'only_free') astro.access = 'members';
  else astro.access = 'public';

  if (post.url) astro.canonicalURL = post.url;

  // Podcast fields
  if (post.type === 'podcast') {
    if (post.audioUrl) astro.audioUrl = post.audioUrl;
    if (post.podcastDuration) astro.audioDuration = post.podcastDuration;
  }

  // Hero image
  if (heroStrategy === 'first-image') {
    const heroUrl = deriveHero(post.html);
    if (heroUrl) {
      const filename = deriveImageFilename(heroUrl.replace(/\?.*$/, ''));
      astro.heroImage = `../../assets/blog/${filename}`;
    }
  }

  // Preserve Substack metadata
  astro.substackId = post.postId;
  astro.substackType = post.type;

  return astro;
}

// ── Sidecar persistence ────────────────────────────────────────────────

export function writeSubstackPosts(posts: SubstackPost[], targetDir: string): void {
  const path = resolve(targetDir, 'portage-substack-posts.json');
  mkdirSync(resolve(targetDir), { recursive: true });
  writeFileSync(path, JSON.stringify(posts, null, 2) + '\n', 'utf-8');
}

export function readSubstackPosts(targetDir: string): SubstackPost[] {
  const path = resolve(targetDir, 'portage-substack-posts.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── Transform ──────────────────────────────────────────────────────────

export interface TransformResult {
  mapped: number;
  rewrites: Array<{ file: string; type: 'link' | 'image' | 'plugin' | 'fragment' | 'other'; from: string; to: string }>;
}

export function transformSubstackContent(posts: SubstackPost[]): TransformResult {
  let mapped = 0;
  const rewrites: TransformResult['rewrites'] = [];

  for (const post of posts) {
    for (const [key] of Object.entries(SUBSTACK_FIELD_KEY_MAP)) {
      if ((post as unknown as Record<string, unknown>)[key] !== undefined) {
        mapped++;
      }
    }

    if (post.html && post.html.includes('<')) {
      rewrites.push({ file: post.slug, type: 'other', from: 'HTML body', to: 'Markdown' });
    }

    if (post.html && SUBSTACK_CDN_PATTERNS.some((p) => post.html.includes(p))) {
      rewrites.push({ file: post.slug, type: 'image', from: 'CDN image', to: 'local path' });
    }
  }

  return { mapped, rewrites };
}

// ── Helpers ────────────────────────────────────────────────────────────
