/**
 * Jekyll project reader: _config.yml parsing, _posts walking with date-prefix
 * extraction, collection discovery, Liquid tag classification, image collection,
 * permalink resolution, and plugin mapping.
 * Owns everything about *reading* a Jekyll source.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import fg from 'fast-glob';
import { checksumFile, type Manifest, type ContentFile, type PluginMapping } from './manifest.js';
import { parseFrontmatter, ensureArray } from './frontmatter.js';

// ── Public API ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  source: string;
  to: string;
  dryRun?: boolean;
  includeDrafts?: boolean;
  permalinkStyle?: 'flat' | 'original' | 'preserve';
}

export interface ExtractResult {
  manifest: Manifest;
  dryRun: boolean;
}

export async function extractJekyll(opts: ExtractOptions): Promise<ExtractResult> {
  const sourceDir = resolve(opts.source);

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const manifest: Manifest = {
    version: '1',
    source: { platform: 'jekyll', path: sourceDir },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };

  // 1. Parse _config.yml
  const config = parseConfig(sourceDir);
  if (config) {
    manifest.extract.plugins = mapPlugins(config.plugins || []);
    manifest.extract.counts.plugins = manifest.extract.plugins.length;
  }

  // 2. Walk _posts/
  for (const f of collectPosts(sourceDir)) {
    manifest.extract.contentFiles.push(f);
  }

  // 3. Walk _drafts/ if --include-drafts
  if (opts.includeDrafts) {
    for (const f of collectDrafts(sourceDir)) {
      manifest.extract.contentFiles.push(f);
    }
  }

  // 4. Walk custom collections
  const collections = config ? resolveCollections(config) : [];
  for (const col of collections) {
    for (const f of collectCollection(sourceDir, col)) {
      manifest.extract.contentFiles.push(f);
    }
  }

  // 5. Walk top-level pages
  for (const f of collectPages(sourceDir)) {
    manifest.extract.contentFiles.push(f);
  }

  // 6. Count posts vs pages vs collections
  for (const f of manifest.extract.contentFiles) {
    if (f.collection === 'blog') manifest.extract.counts.posts++;
    else if (f.collection === 'pages') manifest.extract.counts.pages++;
  }

  // 7. Collect images
  manifest.extract.images = collectImages(sourceDir);
  manifest.extract.counts.images = manifest.extract.images.length;

  // 8. Derive tags and authors from frontmatter
  const meta = countFrontmatterMeta(manifest.extract.contentFiles);
  manifest.extract.counts.tags = meta.tags;
  manifest.extract.counts.authors = meta.authors;

  return { manifest, dryRun: opts.dryRun ?? false };
}

// ── _config.yml parsing ────────────────────────────────────────────────

interface JekyllConfig {
  title?: string;
  description?: string;
  url?: string;
  author?: string;
  permalink?: string;
  collections?: Record<string, { output?: boolean; permalink?: string; sort_by?: string }> | string[];
  defaults?: Array<{ scope: { path?: string; type?: string }; values: Record<string, unknown> }>;
  plugins?: string[];
  showExcerpts?: boolean;
}

function parseConfig(sourceDir: string): JekyllConfig | null {
  const configPath = resolve(sourceDir, '_config.yml');
  if (!existsSync(configPath)) return null;
  try {
    return parseYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function parseYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split('\n');

  // Stack tracks nesting: each entry is { indent, obj, pendingArrayKey, pendingArray }
  // When "key:" has empty value and next lines are "- val", we push a frame
  // that tracks the array directly.
  const stack: Array<{
    indent: number;
    obj: Record<string, unknown>;
    pendingArrayKey?: string;
    pendingArray?: unknown[];
  }> = [{ indent: -1, obj: result }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack back to the right parent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const frame = stack[stack.length - 1];
    const parent = frame.obj;

    // Array item: "- value"
    const arrMatch = trimmed.match(/^- (.+)$/);
    if (arrMatch) {
      // The array items belong to the most recent key that was pushed as a child
      if (frame.pendingArrayKey && frame.pendingArray) {
        frame.pendingArray.push(parseValue(arrMatch[1]));
      } else if (stack.length >= 2) {
        // Maybe the parent frame has the pending array
        const parentFrame = stack[stack.length - 2];
        if (parentFrame.pendingArrayKey && parentFrame.pendingArray) {
          parentFrame.pendingArray.push(parseValue(arrMatch[1]));
        }
      }
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, valStr] = kvMatch;

      if (valStr === '' || valStr === '|' || valStr === '>') {
        // Could be nested object or array parent — peek ahead
        const nextLine = lines.slice(i + 1).find((l) => !/^\s*#/.test(l) && !/^\s*$/.test(l));
        const isNextArray = nextLine != null && /^\s*- /.test(nextLine);

        if (isNextArray) {
          // It's an array — push a frame that tracks the array
          const arr: unknown[] = [];
          parent[key] = arr;
          stack.push({ indent, obj: parent, pendingArrayKey: key, pendingArray: arr });
        } else {
          // It's a nested object
          const child: Record<string, unknown> = {};
          parent[key] = child;
          stack.push({ indent, obj: child });
        }
      } else {
        parent[key] = parseValue(valStr);
      }
      continue;
    }
  }

  return result;
}

function parseValue(valStr: string): unknown {
  if (valStr === 'true') return true;
  if (valStr === 'false') return false;
  if (valStr === 'null' || valStr === '~') return null;
  if (/^-?\d+$/.test(valStr)) return parseInt(valStr, 10);
  if (/^-?\d+\.\d+$/.test(valStr)) return parseFloat(valStr);
  // Strip quotes
  if (/^["'].*["']$/.test(valStr)) return valStr.slice(1, -1);
  return valStr;
}

// ── Collection resolution ───────────────────────────────────────────────

interface CollectionDef {
  name: string;
  output: boolean;
  permalink?: string;
}

function resolveCollections(config: JekyllConfig): CollectionDef[] {
  const collections: CollectionDef[] = [];
  if (!config.collections) return collections;

  if (Array.isArray(config.collections)) {
    // Array form: collections: [staff, projects]
    for (const name of config.collections) {
      if (typeof name === 'string') {
        collections.push({ name, output: false });
      }
    }
  } else if (typeof config.collections === 'object') {
    // Map form: collections: { projects: { output: true } }
    for (const [name, def] of Object.entries(config.collections as Record<string, Record<string, unknown>>)) {
      collections.push({
        name,
        output: def.output === true,
        permalink: typeof def.permalink === 'string' ? def.permalink : undefined,
      });
    }
  }

  return collections;
}

// ── Content walking ─────────────────────────────────────────────────────

function collectPosts(sourceDir: string): ContentFile[] {
  const files: ContentFile[] = [];
  const postsDir = resolve(sourceDir, '_posts');
  if (!existsSync(postsDir)) return files;

  for (const pattern of ['**/*.md', '**/*.markdown', '**/*.html', '**/*.mdx']) {
    for (const absPath of fg.sync(pattern, { cwd: postsDir, absolute: true, onlyFiles: true })) {
      const relInPosts = relative(postsDir, absPath);
      const { date: _date, slug: _slug } = parsePostFilename(relInPosts);
      files.push({
        relativePath: `_posts/${relInPosts}`,
        absolutePath: absPath,
        checksum: checksumFile(absPath),
        format: extname(absPath).slice(1) as 'md' | 'mdx' | 'html',
        collection: 'blog',
      });
    }
  }
  return files;
}

function collectDrafts(sourceDir: string): ContentFile[] {
  const files: ContentFile[] = [];
  const draftsDir = resolve(sourceDir, '_drafts');
  if (!existsSync(draftsDir)) return files;

  for (const pattern of ['**/*.md', '**/*.markdown', '**/*.html', '**/*.mdx']) {
    for (const absPath of fg.sync(pattern, { cwd: draftsDir, absolute: true, onlyFiles: true })) {
      const relInDrafts = relative(draftsDir, absPath);
      files.push({
        relativePath: `_drafts/${relInDrafts}`,
        absolutePath: absPath,
        checksum: checksumFile(absPath),
        format: extname(absPath).slice(1) as 'md' | 'mdx' | 'html',
        collection: 'blog', // Drafts become blog posts with draft: true
      });
    }
  }
  return files;
}

function collectCollection(sourceDir: string, col: CollectionDef): ContentFile[] {
  const files: ContentFile[] = [];
  const colDir = resolve(sourceDir, `_${col.name}`);
  if (!existsSync(colDir)) return files;

  for (const pattern of ['**/*.md', '**/*.markdown', '**/*.html', '**/*.mdx']) {
    for (const absPath of fg.sync(pattern, { cwd: colDir, absolute: true, onlyFiles: true })) {
      const relInCol = relative(colDir, absPath);
      files.push({
        relativePath: `_${col.name}/${relInCol}`,
        absolutePath: absPath,
        checksum: checksumFile(absPath),
        format: extname(absPath).slice(1) as 'md' | 'mdx' | 'html',
        collection: col.name as ContentFile['collection'],
      });
    }
  }
  return files;
}

function collectPages(sourceDir: string): ContentFile[] {
  const files: ContentFile[] = [];
  // Top-level .md/.html files (but not in _ prefixed dirs or _config.yml)
  for (const absPath of fg.sync('*.{md,markdown,html,mdx}', { cwd: sourceDir, absolute: true, onlyFiles: true, ignore: ['_*'] })) {
    files.push({
      relativePath: relative(sourceDir, absPath),
      absolutePath: absPath,
      checksum: checksumFile(absPath),
      format: extname(absPath).slice(1) as 'md' | 'mdx' | 'html',
      collection: 'pages',
    });
  }
  return files;
}

// ── Filename parsing ───────────────────────────────────────────────────

/** Parse a _posts/ filename like "2024-06-15-welcome-to-jekyll.md" */
export function parsePostFilename(filename: string): { date: string | null; slug: string } {
  const base = filename.replace(/\.(md|markdown|html|mdx)$/, '');
  const datePrefix = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (datePrefix) {
    return { date: datePrefix[1], slug: datePrefix[2] };
  }
  return { date: null, slug: base };
}

// ── Image collection ────────────────────────────────────────────────────

function collectImages(sourceDir: string): Manifest['extract']['images'] {
  const images: Manifest['extract']['images'] = [];
  const patterns = [
    { pattern: 'assets/**/*.{png,jpg,jpeg,gif,webp,svg,avif}', source: 'assets' as const },
    { pattern: 'images/**/*.{png,jpg,jpeg,gif,webp,svg,avif}', source: 'assets' as const },
  ];
  for (const { pattern, source: _src } of patterns) {
    for (const absPath of fg.sync(pattern, { cwd: sourceDir, absolute: true, onlyFiles: true })) {
      images.push({ relativePath: relative(sourceDir, absPath), absolutePath: absPath, source: 'src/images' });
    }
  }
  return images;
}

// ── Permalink resolution ───────────────────────────────────────────────

const PERMALINK_BUILTINS: Record<string, string> = {
  pretty: '/:categories/:year/:month/:day/:title/',
  date: '/:categories/:year/:month/:day/:title.html',
  ordinal: '/:categories/:year/:y_day/:title.html',
  none: '/:categories/:title.html',
  weekdate: '/:categories/:year/W:week/:short_day/:title.html',
};

export function resolvePermalinkPattern(configPermalink: string | undefined): string | null {
  if (!configPermalink) return PERMALINK_BUILTINS.pretty; // Jekyll default
  if (PERMALINK_BUILTINS[configPermalink]) return PERMALINK_BUILTINS[configPermalink];
  return configPermalink; // Custom pattern like "/:year/:month/:title/"
}

export function expandPermalink(
  pattern: string,
  data: { year?: string; month?: string; day?: string; title?: string; categories?: string[]; slug?: string; collection?: string; name?: string },
): string {
  let url = pattern
    .replace(':year', data.year || '')
    .replace(':short_year', data.year?.slice(2) || '')
    .replace(':month', data.month || '')
    .replace(':i_month', data.month?.replace(/^0/, '') || '')
    .replace(':day', data.day || '')
    .replace(':i_day', data.day?.replace(/^0/, '') || '')
    .replace(':title', data.title || '')
    .replace(':slug', data.slug || data.title || '')
    .replace(':name', data.name || data.slug || '')
    .replace(':collection', data.collection || '')
    .replace(':output_ext', '.html')
    .replace(':categories', data.categories?.join('/') || '')
    .replace(':slugified_categories', data.categories?.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-')).join('/') || '');

  // Clean up double slashes from empty categories
  url = url.replace(/\/+/g, '/').replace(/\/$/, '/') || '/';
  return url;
}

// ── Liquid tag detection ───────────────────────────────────────────────

export interface LiquidTagResult {
  highlight: number;
  include: number;
  postUrl: number;
  link: number;
  variable: number;
  raw: number;
  other: number;
  total: number;
}

export function detectLiquidTags(body: string): LiquidTagResult {
  const result: LiquidTagResult = { highlight: 0, include: 0, postUrl: 0, link: 0, variable: 0, raw: 0, other: 0, total: 0 };

  // {% highlight lang %}...{% endhighlight %}
  const highlightMatches = body.match(/\{%\s*highlight\s+\w+\s*%\}/g);
  result.highlight = highlightMatches?.length ?? 0;

  // {% include file.ext %}
  const includeMatches = body.match(/\{%\s*include\s+[\w./-]+\s*%\}/g);
  result.include = includeMatches?.length ?? 0;

  // {% post_url ... %}
  const postUrlMatches = body.match(/\{%\s*post_url\s+[\w./-]+\s*%\}/g);
  result.postUrl = postUrlMatches?.length ?? 0;

  // {% link ... %}
  const linkMatches = body.match(/\{%\s*link\s+[\w./-]+\s*%\}/g);
  result.link = linkMatches?.length ?? 0;

  // {{ variable }}
  const variableMatches = body.match(/\{\{\s*[\w.]+\s*\}\}/g);
  result.variable = variableMatches?.length ?? 0;

  // {% raw %}...{% endraw %}
  const rawMatches = body.match(/\{%\s*raw\s*%\}/g);
  result.raw = rawMatches?.length ?? 0;

  // Count all Liquid tags
  const allBlockTags = body.match(/\{%\s*[^%]+%\}/g) || [];
  const allVarTags = body.match(/\{\{\s*[^}]+\}\}/g) || [];
  result.total = allBlockTags.length + allVarTags.length;

  // Other = total - known categories
  const known = result.highlight + result.include + result.postUrl + result.link + result.raw;
  // Variable tags counted separately (they're {{ }} not {% %})
  result.other = Math.max(0, result.total - known - result.variable);

  return result;
}

export function convertLiquidTags(body: string): string {
  let result = body;

  // {% highlight lang %}code{% endhighlight %} → ```lang\ncode\n```
  result = result.replace(
    /\{%\s*highlight\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endhighlight\s*%\}/g,
    (_m, lang, code) => `\`\`\`${lang}\n${code}\n\`\`\``,
  );

  // {% post_url 2024-06-15-slug %} → /blog/slug/  (best-effort; actual slug resolved at load time)
  result = result.replace(
    /\{%\s*post_url\s+\d{4}-\d{2}-\d{2}-([\w-]+)\s*%\}/g,
    (_m, slug) => `/blog/${slug}/`,
  );

  // {% link collection/name.md %} → /collection/name/
  result = result.replace(
    /\{%\s*link\s+([\w-]+)\/([\w-]+)\.\w+\s*%\}/g,
    (_m, collection, name) => `/${collection}/${name}/`,
  );

  // {% include file.ext %} → <!-- include: file.ext -->
  result = result.replace(
    /\{%\s*include\s+([\w./-]+)\s*%\}/g,
    (_m, file) => `<!-- include: ${file} -->`,
  );

  // {% raw %}...{% endraw %} → content as-is
  result = result.replace(
    /\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g,
    (_m, content) => content,
  );

  // {{ page.title }} etc → HTML comment
  result = result.replace(
    /\{\{\s*(page|site|layout)\.([\w.]+)\s*\}\}/g,
    (_m, _ns, key) => `<!-- variable: ${key} -->`,
  );

  return result;
}

// ── Plugin mapping ──────────────────────────────────────────────────────

const PLUGIN_MAP: Record<string, { equivalent: string | undefined; needsReview: boolean }> = {
  'jekyll-feed':    { equivalent: '@astrojs/rss', needsReview: false },
  'jekyll-sitemap': { equivalent: '@astrojs/sitemap', needsReview: false },
  'jekyll-seo-tag': { equivalent: 'frontmatter seo fields', needsReview: false },
  'jekyll-redirect-from': { equivalent: 'redirect map', needsReview: false },
  'jekyll-paginate':      { equivalent: 'Astro pagination (built-in)', needsReview: false },
  'jekyll-compose':       { equivalent: undefined, needsReview: true },
  'jekyll-gist':          { equivalent: 'embedded gist (manual)', needsReview: true },
  'jekyll-mentions':      { equivalent: undefined, needsReview: true },
  'jekyll-archives':      { equivalent: 'generated taxonomy pages', needsReview: true },
};

function mapPlugins(plugins: string[]): PluginMapping[] {
  return plugins.map((p) => {
    const mapping = PLUGIN_MAP[p];
    return {
      gatsbyPlugin: p, // Reuse the same schema field; for Jekyll this is the gem name
      astroEquivalent: mapping?.equivalent,
      options: undefined,
      needsReview: mapping?.needsReview ?? true,
    };
  });
}

// ── Plugin registry (used by transform command) ─────────────────────────

const REGISTRY: Record<string, { astroEquivalent: string | undefined; needsReview: boolean }> = {
  'jekyll-feed':           { astroEquivalent: '@astrojs/rss', needsReview: false },
  'jekyll-sitemap':        { astroEquivalent: '@astrojs/sitemap', needsReview: false },
  'jekyll-seo-tag':        { astroEquivalent: 'frontmatter seo fields', needsReview: false },
  'jekyll-redirect-from':  { astroEquivalent: 'redirect map', needsReview: false },
  'jekyll-paginate':       { astroEquivalent: 'Astro pagination (built-in)', needsReview: false },
  'jekyll-compose':        { astroEquivalent: undefined, needsReview: true },
  'jekyll-gist':           { astroEquivalent: 'embedded gist (manual)', needsReview: true },
  'jekyll-mentions':       { astroEquivalent: undefined, needsReview: true },
  'jekyll-archives':       { astroEquivalent: 'generated taxonomy pages', needsReview: true },
};

export interface JekyllPluginRegistryResult { mapped: number; unmapped: string[] }

export function mapJekyllPluginsToAstro(plugins: PluginMapping[]): JekyllPluginRegistryResult {
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

// ── Slug derivation ─────────────────────────────────────────────────────

export function deriveSlug(relativePath: string): string {
  // _posts/2024-06-15-my-post.md → my-post
  // _drafts/my-draft.md → my-draft
  // _projects/my-project.md → my-project
  // about.md → about
  let path = relativePath;

  // Strip directory prefix
  path = path.replace(/^_posts\//, '').replace(/^_drafts\//, '').replace(/^_[\w-]+\//, '');

  // Strip extension
  path = path.replace(/\.(md|markdown|html|mdx)$/, '');

  // Strip date prefix
  const datePrefix = path.match(/^\d{4}-\d{2}-\d{2}-(.+)/);
  if (datePrefix) path = datePrefix[1];

  // Strip index
  path = path.replace(/\/index$/, '');

  return path;
}

// ── Frontmatter meta counting ──────────────────────────────────────────

function countFrontmatterMeta(files: ContentFile[]): { tags: number; authors: number } {
  const tagSet = new Set<string>();
  const authorSet = new Set<string>();
  for (const f of files) {
    try {
      const raw = readFileSync(f.absolutePath, 'utf-8');
      const fmStr = raw.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || '';
      const fm = parseFrontmatter(fmStr);

      // Merge categories + tags into tagSet
      if (fm.tags) ensureArray(fm.tags).forEach((t: unknown) => tagSet.add(String(t)));
      if (fm.categories) ensureArray(fm.categories).forEach((c: unknown) => tagSet.add(String(c)));
      if (fm.category) ensureArray(fm.category).forEach((c: unknown) => tagSet.add(String(c)));

      // Authors
      if (fm.author) authorSet.add(String(fm.author));
      if (fm.authors) ensureArray(fm.authors).forEach((a: unknown) => authorSet.add(String(a)));
    } catch { /* skip */ }
  }
  return { tags: tagSet.size, authors: authorSet.size };
}

// ── Jekyll field mapping ───────────────────────────────────────────────

/** Jekyll-specific field key mapping for the collection writer. */
export const JEKYLL_FIELD_KEY_MAP: Record<string, string> = {
  title: 'title',
  description: 'description',
  excerpt: 'description',
  date: 'pubDate',
  author: 'authors',
  authors: 'authors',
  categories: 'tags',    // merged into tags
  category: 'tags',      // merged into tags
  tags: 'tags',          // merged with categories
  image: 'heroImage',
  thumbnail: 'heroImage',
  imageAlt: 'heroImageAlt',
  image_alt: 'heroImageAlt',
  published: 'draft',    // inverted: published:false → draft:true
  permalink: '_permalink',
  redirect_from: 'redirects',
  canonical_url: 'canonicalURL',
  layout: '_layout',     // preserved in jekyll: namespace
};

// ── Jekyll transform ────────────────────────────────────────────────────

export interface JekyllTransformResult {
  mapped: number;
  rewrites: Array<{ file: string; type: 'link' | 'image' | 'plugin' | 'fragment' | 'other'; from: string; to: string }>;
}

export function transformJekyllContent(manifest: Manifest): JekyllTransformResult {
  let mapped = 0;
  const rewrites: JekyllTransformResult['rewrites'] = [];

  for (const file of manifest.extract.contentFiles) {
    try {
      const raw = readFileSync(file.absolutePath, 'utf-8');
      const parsed = splitFrontmatterRaw(raw);
      if (!parsed) continue;
      const { frontmatter } = parsed;

      for (const [key, value] of Object.entries(frontmatter)) {
        const astroKey = JEKYLL_FIELD_KEY_MAP[key];
        if (astroKey) {
          mapped++;
          // Track special transforms
          if (key === 'categories' || key === 'category') {
            rewrites.push({ file: file.relativePath, type: 'other', from: key, to: `tags (merged)` });
          }
          if (key === 'published' && value === false) {
            rewrites.push({ file: file.relativePath, type: 'other', from: 'published: false', to: 'draft: true' });
          }
        }
      }

      // Check for Liquid tags in body
      const liquidResult = detectLiquidTags(parsed.body);
      if (liquidResult.total > 0) {
        rewrites.push({ file: file.relativePath, type: 'other', from: `${liquidResult.total} Liquid tags`, to: `${liquidResult.highlight} highlights converted, ${liquidResult.other} preserved as comments` });
      }
    } catch { /* skip */ }
  }

  return { mapped, rewrites };
}

function splitFrontmatterRaw(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: parseFrontmatter(match[1]), body: match[2] };
}
