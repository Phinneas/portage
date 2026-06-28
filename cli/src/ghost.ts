/**
 * Ghost JSON export parser. Reads a ghost-export.json file and produces
 * a unified set of posts, pages, tags, authors, and image references.
 *
 * Shared by both ghost2astro and ghost2payload routes. The extract phase
 * is identical; the load phase diverges based on the --target flag.
 *
 * Ghost export structure:
 *   {
 *     "db": [{
 *       "meta": { ... },
 *       "data": {
 *         "posts": [...],
 *         "posts_tags": [...],
 *         "posts_authors": [...],
 *         "tags": [...],
 *         "users": [...],
 *         "posts_meta": [...]
 *       }
 *     }]
 *   }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { Manifest, PluginMapping } from './manifest.js';
import { checksumString } from './asset_handler.js';
import { coerceDate } from './frontmatter.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface GhostPost {
  id: string;
  uuid: string;
  title: string;
  slug: string;
  customExcerpt: string;
  html: string;
  lexical: string;
  featureImage: string;
  featureImageAlt: string;
  featureImageCaption: string;
  publishedAt: string;
  updatedAt: string;
  createdAt: string;
  status: 'published' | 'draft' | 'scheduled';
  visibility: 'public' | 'members' | 'paid' | 'private';
  type: 'post' | 'page';
  featured: boolean;
  canonicalUrl: string;
  metaTitle: string;
  metaDescription: string;
  ogImage: string;
  ogTitle: string;
  ogDescription: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  codeinjectionHead: string;
  codeinjectionFoot: string;
  tagIds: string[];
  authorIds: string[];
  emailOnly: boolean;
}

export interface GhostTag {
  id: string;
  uuid: string;
  name: string;
  slug: string;
  description: string;
  featureImage: string;
  isInternal: boolean;
}

export interface GhostAuthor {
  id: string;
  uuid: string;
  name: string;
  slug: string;
  bio: string;
  profileImage: string;
  website: string;
  location: string;
  facebook: string;
  twitter: string;
}

export interface GhostExport {
  posts: GhostPost[];
  tags: GhostTag[];
  authors: GhostAuthor[];
  meta: {
    title: string;
    description: string;
    url: string;
  };
}

export interface ExtractOptions {
  export: string;
  to: string;
  ghostUrl?: string;
  includeDrafts?: boolean;
  dryRun?: boolean;
}

export interface ExtractResult {
  manifest: Manifest;
  dryRun: boolean;
  ghostExport: GhostExport;
}

// ── Main Extraction ─────────────────────────────────────────────────────

export async function extractGhost(opts: ExtractOptions): Promise<ExtractResult> {
  const exportPath = resolve(opts.export);

  if (!existsSync(exportPath)) {
    throw new Error(`Export file not found: ${exportPath}`);
  }

  const manifest: Manifest = {
    version: '1',
    source: { platform: 'ghost', path: exportPath },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };

  // 1. Parse the Ghost JSON export
  const ghostExport = parseGhostExport(exportPath, opts.ghostUrl);

  // 2. Filter drafts if not included
  const posts = opts.includeDrafts
    ? ghostExport.posts
    : ghostExport.posts.filter((p) => p.status === 'published');

  // 3. Convert posts to ContentFiles
  for (const post of posts) {
    const collection = post.type === 'page' ? 'pages' : 'blog';
    manifest.extract.contentFiles.push({
      relativePath: `${collection}/${post.slug}.md`,
      absolutePath: '',
      checksum: checksumString(post.html || post.lexical || ''),
      format: 'md',
      collection,
    });
  }

  // 4. Count by type
  for (const f of manifest.extract.contentFiles) {
    if (f.collection === 'blog') manifest.extract.counts.posts++;
    else if (f.collection === 'pages') manifest.extract.counts.pages++;
  }

  // 5. Extract images
  manifest.extract.images = extractGhostImages(ghostExport);
  manifest.extract.counts.images = manifest.extract.images.length;

  // 6. Tags and authors
  manifest.extract.counts.tags = ghostExport.tags.filter((t) => !t.isInternal).length;
  manifest.extract.counts.authors = ghostExport.authors.length;

  // 7. Map features
  manifest.extract.plugins = mapFeatures();
  manifest.extract.counts.plugins = manifest.extract.plugins.length;

  return { manifest, dryRun: opts.dryRun ?? false, ghostExport };
}

// ── Ghost JSON Parser ───────────────────────────────────────────────────

export function parseGhostExport(filePath: string, ghostUrl?: string): GhostExport {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));

  // Ghost exports have a db array with meta + data
  const db = Array.isArray(raw.db) ? raw.db : [raw];
  const data = db[0]?.data || raw;
  const meta = db[0]?.meta || {};

  const ghostBaseUrl = ghostUrl || meta.url || '';

  // Parse join tables
  const postsTags: Array<{ post_id: string; tag_id: string }> = data.posts_tags || data.post_tags || [];
  const postsAuthors: Array<{ post_id: string; author_id: string }> = data.posts_authors || data.post_authors || [];

  // Parse tags
  const tagMap = new Map<string, GhostTag>();
  const rawTags: Record<string, unknown>[] = data.tags || [];
  for (const t of rawTags) {
    const tag: GhostTag = {
      id: String(t.id || ''),
      uuid: String(t.uuid || ''),
      name: String(t.name || ''),
      slug: String(t.slug || ''),
      description: String(t.description || ''),
      featureImage: resolveGhostUrl(String(t.feature_image || ''), ghostBaseUrl),
      isInternal: String(t.name || '').startsWith('#'),
    };
    tagMap.set(tag.id, tag);
  }

  // Parse authors
  const authorMap = new Map<string, GhostAuthor>();
  const rawAuthors: Record<string, unknown>[] = data.users || [];
  for (const a of rawAuthors) {
    const author: GhostAuthor = {
      id: String(a.id || ''),
      uuid: String(a.uuid || ''),
      name: String(a.name || ''),
      slug: String(a.slug || ''),
      bio: String(a.bio || ''),
      profileImage: resolveGhostUrl(String(a.profile_image || ''), ghostBaseUrl),
      website: String(a.website || ''),
      location: String(a.location || ''),
      facebook: String(a.facebook || ''),
      twitter: String(a.twitter || ''),
    };
    authorMap.set(author.id, author);
  }

  // Parse posts
  const posts: GhostPost[] = [];
  const rawPosts: Record<string, unknown>[] = data.posts || [];
  for (const p of rawPosts) {
    const postId = String(p.id || '');

    // Resolve tag IDs from join table
    const tagIds = postsTags
      .filter((pt) => String(pt.post_id) === postId)
      .map((pt) => String(pt.tag_id));

    // Resolve author IDs from join table
    const authorIds = postsAuthors
      .filter((pa) => String(pa.post_id) === postId)
      .map((pa) => String(pa.author_id));

    const lexical = p.lexical ? (typeof p.lexical === 'string' ? p.lexical : JSON.stringify(p.lexical)) : '';

    const post: GhostPost = {
      id: postId,
      uuid: String(p.uuid || ''),
      title: String(p.title || ''),
      slug: String(p.slug || ''),
      customExcerpt: String(p.custom_excerpt || p.excerpt || ''),
      html: String(p.html || ''),
      lexical,
      featureImage: resolveGhostUrl(String(p.feature_image || ''), ghostBaseUrl),
      featureImageAlt: String(p.feature_image_alt || ''),
      featureImageCaption: String(p.feature_image_caption || ''),
      publishedAt: String(p.published_at || p.created_at || ''),
      updatedAt: String(p.updated_at || ''),
      createdAt: String(p.created_at || ''),
      status: (['published', 'draft', 'scheduled'].includes(String(p.status)) ? p.status : 'draft') as GhostPost['status'],
      visibility: (['public', 'members', 'paid', 'private'].includes(String(p.visibility)) ? p.visibility : 'public') as GhostPost['visibility'],
      type: String(p.type) === 'page' ? 'page' : 'post',
      featured: Boolean(p.featured),
      canonicalUrl: String(p.canonical_url || ''),
      metaTitle: String(p.meta_title || ''),
      metaDescription: String(p.meta_description || ''),
      ogImage: resolveGhostUrl(String(p.og_image || ''), ghostBaseUrl),
      ogTitle: String(p.og_title || ''),
      ogDescription: String(p.og_description || ''),
      twitterTitle: String(p.twitter_title || ''),
      twitterDescription: String(p.twitter_description || ''),
      twitterImage: resolveGhostUrl(String(p.twitter_image || ''), ghostBaseUrl),
      codeinjectionHead: String(p.codeinjection_head || ''),
      codeinjectionFoot: String(p.codeinjection_foot || ''),
      tagIds,
      authorIds,
      emailOnly: String(p.email_only) === 'true' || String(p.status) === 'sent',
    };

    posts.push(post);
  }

  return {
    posts,
    tags: Array.from(tagMap.values()),
    authors: Array.from(authorMap.values()),
    meta: {
      title: String(meta.title || ''),
      description: String(meta.description || ''),
      url: ghostBaseUrl,
    },
  };
}

// ── Ghost URL Resolution ────────────────────────────────────────────────

export function resolveGhostUrl(url: string, ghostBaseUrl: string): string {
  if (!url) return '';
  // Replace __GHOST_URL__ placeholder with actual base URL
  return url.replace(/__GHOST_URL__/g, ghostBaseUrl).replace(/\/content\/images\/size\//g, '/content/images/');
}

// ── Image Extraction ────────────────────────────────────────────────────

export function extractGhostImages(ghostExport: GhostExport): Manifest['extract']['images'] {
  const images: Manifest['extract']['images'] = [];
  const seen = new Set<string>();

  const collectImage = (url: string) => {
    if (!url) return;
    // Strip Ghost size variants for dedup
    const bareUrl = url.replace(/\/size\/w\d+\//, '/').replace(/\?format=\w+$/, '');
    if (seen.has(bareUrl)) return;
    seen.add(bareUrl);
    const filename = basename(new URL(bareUrl).pathname);
    images.push({ relativePath: filename, absolutePath: url, source: 'remote' });
  };

  for (const post of ghostExport.posts) {
    collectImage(post.featureImage);
    collectImage(post.ogImage);
    collectImage(post.twitterImage);
    // Extract inline images from HTML body
    const imgRe = /src="([^"]*(?:\/content\/images\/|__GHOST_URL__)[^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = imgRe.exec(post.html)) !== null) {
      collectImage(match[1]);
    }
  }

  for (const tag of ghostExport.tags) {
    collectImage(tag.featureImage);
  }

  for (const author of ghostExport.authors) {
    collectImage(author.profileImage);
  }

  return images;
}

// ── Feature Mapping ─────────────────────────────────────────────────────

function mapFeatures(): PluginMapping[] {
  return [
    { gatsbyPlugin: 'members', astroEquivalent: undefined, options: undefined, needsReview: true },
    { gatsbyPlugin: 'subscriptions', astroEquivalent: undefined, options: undefined, needsReview: true },
    { gatsbyPlugin: 'email-newsletter', astroEquivalent: undefined, options: undefined, needsReview: true },
  ];
}

// ── Plugin Registry ────────────────────────────────────────────────────

const REGISTRY: Record<string, { astroEquivalent: string | undefined; needsReview: boolean }> = {
  'members':          { astroEquivalent: undefined, needsReview: true },
  'subscriptions':    { astroEquivalent: undefined, needsReview: true },
  'email-newsletter': { astroEquivalent: undefined, needsReview: true },
};

export interface PluginRegistryResult { mapped: number; unmapped: string[] }

export function mapGhostFeaturesToAstro(plugins: PluginMapping[]): PluginRegistryResult {
  let mapped = 0;
  const unmapped: string[] = [];
  for (const plugin of plugins) {
    const entry = REGISTRY[plugin.gatsbyPlugin];
    if (entry) {
      plugin.astroEquivalent = entry.astroEquivalent;
      plugin.needsReview = entry.needsReview;
      unmapped.push(plugin.gatsbyPlugin);
    } else {
      unmapped.push(plugin.gatsbyPlugin);
    }
  }
  return { mapped, unmapped };
}

// ── Ghost → Payload Field Mapping ───────────────────────────────────────

export const GHOST_PAYLOAD_FIELD_MAP: Record<string, string> = {
  title: 'title',
  slug: 'slug',
  customExcerpt: 'excerpt',
  lexical: 'content',
  html: 'htmlContent',
  featureImage: 'featureImage',
  featureImageAlt: 'featureImageAlt',
  featureImageCaption: 'featureImageCaption',
  publishedAt: 'publishedAt',
  updatedAt: 'updatedAt',
  tagIds: 'tags',
  authorIds: 'authors',
  metaTitle: 'seo.title',
  metaDescription: 'seo.description',
  ogImage: 'seo.openGraph.image',
  ogTitle: 'seo.openGraph.title',
  ogDescription: 'seo.openGraph.description',
  twitterTitle: 'seo.twitter.title',
  twitterDescription: 'seo.twitter.description',
  twitterImage: 'seo.twitter.image',
  canonicalUrl: 'canonicalUrl',
  featured: 'featured',
  visibility: 'visibility',
  status: '_status',
  codeinjectionHead: 'ghost.codeInjection.head',
  codeinjectionFoot: 'ghost.codeInjection.foot',
};

// ── Ghost → Payload Frontmatter (for Astro output) ─────────────────────

export const GHOST_ASTRO_FIELD_MAP: Record<string, string> = {
  uuid: 'ghostUuid',
  title: 'title',
  slug: '_slug',
  customExcerpt: 'description',
  html: '_body',
  featureImage: 'heroImage',
  featureImageAlt: 'heroImageAlt',
  featureImageCaption: 'heroImageCaption',
  publishedAt: 'pubDate',
  updatedAt: 'updatedDate',
  tagIds: 'tags',
  authorIds: 'authors',
  metaTitle: 'seo.title',
  metaDescription: 'seo.description',
  canonicalUrl: 'canonicalURL',
  featured: 'featured',
  visibility: 'access',
  status: 'draft',
};

// ── Ghost → Astro frontmatter mapping ────────────────────────────────

export function mapGhostFrontmatter(
  post: GhostPost,
  tagNames: string[],
  authorNames: string[],
  heroStrategy: 'first-image' | 'none' = 'first-image',
): Record<string, unknown> {
  const astro: Record<string, unknown> = {};

  // Preserve Ghost GID for reference
  astro.ghostUuid = post.uuid;

  astro.title = post.title;

  if (post.slug) astro._slug = post.slug;

  if (post.customExcerpt) astro.description = post.customExcerpt;

  const pubDate = coerceDate(post.publishedAt);
  if (pubDate) astro.pubDate = pubDate;

  if (post.updatedAt && post.updatedAt !== post.publishedAt) {
    const updDate = coerceDate(post.updatedAt);
    if (updDate) astro.updatedDate = updDate;
  }

  // Tags: resolved names from join table
  if (tagNames.length > 0) astro.tags = tagNames;

  // Authors: resolved names from join table
  if (authorNames.length > 0) astro.authors = authorNames;

  // Feature image
  if (post.featureImage) {
    if (heroStrategy === 'first-image') {
      const filename = basename(new URL(post.featureImage.replace(/\/size\/w\d+\//, '/content/images/')).pathname);
      astro.heroImage = `../../assets/blog/${filename}`;
    } else {
      astro.heroImage = post.featureImage;
    }
  }

  if (post.featureImageAlt) astro.heroImageAlt = post.featureImageAlt;
  if (post.featureImageCaption) {
    // Strip HTML from caption for frontmatter
    astro.heroImageCaption = post.featureImageCaption.replace(/<[^>]+>/g, '').trim();
  }

  // Visibility → access control
  if (post.visibility === 'members') astro.access = 'members';
  else if (post.visibility === 'paid') astro.access = 'paid';
  else astro.access = 'public';

  // Draft status
  astro.draft = post.status === 'draft' || post.status === 'scheduled';

  // Featured
  astro.featured = post.featured;

  // SEO
  if (post.metaTitle || post.metaDescription) {
    const seo: Record<string, string> = {};
    if (post.metaTitle) seo.title = post.metaTitle;
    if (post.metaDescription) seo.description = post.metaDescription;
    astro.seo = seo;
  }

  // Canonical URL
  if (post.canonicalUrl) astro.canonicalURL = post.canonicalUrl;

  // Type hint for collection routing
  if (post.type === 'page') astro.type = 'page';

  return astro;
}

// ── Sidecar Persistence ────────────────────────────────────────────────

export function writeGhostExport(ghostExport: GhostExport, targetDir: string): void {
  const path = resolve(targetDir, 'portage-ghost-export.json');
  mkdirSync(resolve(targetDir), { recursive: true });
  writeFileSync(path, JSON.stringify(ghostExport, null, 2) + '\n', 'utf-8');
}

export function readGhostExport(targetDir: string): GhostExport | null {
  const path = resolve(targetDir, 'portage-ghost-export.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── Helpers ────────────────────────────────────────────────────────────
