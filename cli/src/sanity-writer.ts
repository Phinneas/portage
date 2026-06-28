/**
 * Sanity CMS writer. Converts WXR items (from the shared parser) into
 * Sanity NDJSON documents, generates a Sanity schema definition file,
 * and produces an import tarball compatible with `sanity dataset import`.
 *
 * Used by the squarespace2sanity route. The extract phase (wxr-parser.ts
 * + squarespace.ts) produces WxrItem[]; this module converts them into
 * Sanity documents with proper _id, _type, references, and _sanityAsset
 * conventions.
 *
 * Squarespace-specific handling vs generic WordPress WXR:
 *   - No custom post types (only post/page)
 *   - Cleaner HTML content (no WordPress shortcodes)
 *   - CDN images on images.squarespace-cdn.com (public, no auth)
 *   - No comments, no postmeta with plugin data
 *   - Simpler taxonomy (flat tags + categories, no custom taxonomies)
 *
 * NDJSON ordering:
 *   1. Schema types (defineType definitions)
 *   2. Taxonomy documents (tags, categories)
 *   3. Media assets (image documents with _sanityAsset)
 *   4. Authors (creator → person documents)
 *   5. Posts and pages (referencing tags, categories, authors, media)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { Manifest } from './manifest.js';
import { parseWxr, type WxrItem, type WxrChannelInfo, type WxrCategory, type WxrTag, wxrSlugify } from './wxr-parser.js';
import { readWxrItems } from './squarespace.js';
import { coerceDate } from './frontmatter.js';
import { htmlToPortableText, stripTags } from './block_parser.js';
import { downloadAllRemoteImages, sqspUrlTransform, sqspFilenameTransform, type BatchDownloadResult } from './asset_handler.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface SanityDocument {
  _id: string;
  _type: string;
  [key: string]: unknown;
}

export interface SanityNdjsonResult {
  documents: SanityDocument[];
  idMap: Record<string, string>;
  schemaTypes: string[];
  assetPaths: string[];
}

export interface SanityWriteResult {
  documentsWritten: number;
  assetsDownloaded: number;
  schemaTypes: number;
  outputPath: string;
}

// ── ID Strategy ────────────────────────────────────────────────────────

export type IdStrategy = 'prefix' | 'original';

function makeSanityId(prefix: string, id: string | number, strategy: IdStrategy): string {
  if (strategy === 'original') return String(id);
  return `${prefix}_${id}`;
}

// ── HTML → Portable Text (imported from block_parser.ts) ──────────────

// Re-export for backward compatibility
export { htmlToPortableText } from './block_parser.js';

// ── Field Mapping: WXR → Sanity ─────────────────────────────────────────

export const WXR_SANITY_FIELD_MAP: Record<string, string> = {
  title: 'title',
  postName: 'slug',
  content: 'body',
  excerpt: 'excerpt',
  pubDate: 'publishedAt',
  postDate: 'publishedAt',
  status: '_status',
  tags: 'tags',
  categories: 'categories',
  creator: 'authors',
  link: 'originalUrl',
};

// ── WXR Item → Sanity Document ─────────────────────────────────────────

export function mapWxrItemToSanity(
  item: WxrItem,
  idMap: Record<string, string>,
  tagMap: Record<string, string>,
  categoryMap: Record<string, string>,
  authorMap: Record<string, string>,
  mediaMap: Record<string, string>,
  idStrategy: IdStrategy = 'prefix',
): SanityDocument {
  const docType = item.postType === 'page' ? 'page' : 'post';
  const docId = makeSanityId(docType, item.postId || wxrSlugify(item.title), idStrategy);

  // Register in ID map
  idMap[`item_${item.postId}`] = docId;

  const doc: SanityDocument = {
    _id: docId,
    _type: docType,
  };

  // Title
  doc.title = item.title;

  // Slug
  doc.slug = {
    _type: 'slug',
    current: item.postName || wxrSlugify(item.title),
  };

  // Body → Portable Text
  if (item.content) {
    doc.body = htmlToPortableText(item.content);
  }

  // Excerpt
  if (item.excerpt) {
    doc.excerpt = stripTags(item.excerpt);
  }

  // Published date
  const dateVal = coerceDate(item.pubDate || item.postDate);
  if (dateVal) doc.publishedAt = dateVal;

  // Status
  doc._status = item.status === 'draft' ? 'draft' : 'published';

  // Tags → references
  if (item.tags.length > 0) {
    doc.tags = item.tags.map((t) => {
      const ref = tagMap[t];
      return ref ? { _type: 'reference', _ref: ref, _weak: true } : t;
    });
  }

  // Categories → references
  if (item.categories.length > 0) {
    doc.categories = item.categories.map((c) => {
      const ref = categoryMap[c];
      return ref ? { _type: 'reference', _ref: ref, _weak: true } : c;
    });
  }

  // Authors → references
  if (item.creator) {
    const authorRef = authorMap[item.creator];
    doc.authors = [{ _type: 'reference', _ref: authorRef, _weak: true }];
  }

  // Original URL
  if (item.link) doc.originalUrl = item.link;

  // Hero image from first inline image (Squarespace-specific)
  const heroUrl = extractFirstSqspImage(item.content);
  if (heroUrl && mediaMap[heroUrl]) {
    doc.featureImage = {
      _type: 'image',
      _sanityAsset: `image@file:///assets/${mediaMap[heroUrl]}`,
      alt: '',
    };
  }

  return doc;
}

function extractFirstSqspImage(html: string): string | null {
  if (!html) return null;
  const match = html.match(/src="(https:\/\/images\.squarespace-cdn\.com\/[^"]+)"/);
  if (!match) return null;
  return match[1].replace(/\?format=\w+$/, '');
}

// ── Tag → Sanity Document ──────────────────────────────────────────────

export function mapWxrTagToSanity(
  tag: { name: string; slug?: string },
  idMap: Record<string, string>,
  idStrategy: IdStrategy = 'prefix',
): SanityDocument {
  const docId = makeSanityId('tag', wxrSlugify(tag.name), idStrategy);
  idMap[`tag_${tag.name}`] = docId;

  return {
    _id: docId,
    _type: 'tag',
    name: tag.name,
    slug: {
      _type: 'slug',
      current: tag.slug || wxrSlugify(tag.name),
    },
  };
}

// ── Category → Sanity Document ──────────────────────────────────────────

export function mapWxrCategoryToSanity(
  cat: { name: string; slug?: string },
  idMap: Record<string, string>,
  idStrategy: IdStrategy = 'prefix',
): SanityDocument {
  const docId = makeSanityId('category', wxrSlugify(cat.name), idStrategy);
  idMap[`category_${cat.name}`] = docId;

  return {
    _id: docId,
    _type: 'category',
    name: cat.name,
    slug: {
      _type: 'slug',
      current: cat.slug || wxrSlugify(cat.name),
    },
  };
}

// ── Author → Sanity Document ────────────────────────────────────────────

export function mapWxrAuthorToSanity(
  author: { login: string; displayName: string; email?: string },
  idMap: Record<string, string>,
  idStrategy: IdStrategy = 'prefix',
): SanityDocument {
  const docId = makeSanityId('author', author.login || wxrSlugify(author.displayName), idStrategy);
  idMap[`author_${author.login || author.displayName}`] = docId;

  const doc: SanityDocument = {
    _id: docId,
    _type: 'author',
    name: author.displayName,
    slug: {
      _type: 'slug',
      current: author.login || wxrSlugify(author.displayName),
    },
  };

  if (author.email) doc.email = author.email;

  return doc;
}

// ── Sanity Schema Generation ────────────────────────────────────────────

export function generateSanitySchema(_channelInfo?: WxrChannelInfo): string {

  return `// Generated by Portage — Squarespace → Sanity migration
// Import into your sanity.config.ts
import { defineType, defineField } from 'sanity';

export const post = defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string' }),
    defineField({
      name: 'slug', type: 'slug',
      options: { source: 'title', maxLength: 96 },
    }),
    defineField({ name: 'body', type: 'array', of: [
      { type: 'block' },
      { type: 'image' },
      { type: 'code' },
    ]}),
    defineField({ name: 'excerpt', type: 'text' }),
    defineField({ name: 'publishedAt', type: 'datetime' }),
    defineField({ name: 'featureImage', type: 'image', options: { hotspot: true } }),
    defineField({ name: 'tags', type: 'array', of: [
      { type: 'reference', to: [{ type: 'tag' }] },
      { type: 'string' },
    ]}),
    defineField({ name: 'categories', type: 'array', of: [
      { type: 'reference', to: [{ type: 'category' }] },
      { type: 'string' },
    ]}),
    defineField({ name: 'authors', type: 'array', of: [
      { type: 'reference', to: [{ type: 'author' }] },
    ]}),
    defineField({ name: 'originalUrl', type: 'url' }),
  ],
  preview: { select: { title: 'title', subtitle: 'publishedAt' } },
});

export const page = defineType({
  name: 'page',
  title: 'Page',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string' }),
    defineField({
      name: 'slug', type: 'slug',
      options: { source: 'title', maxLength: 96 },
    }),
    defineField({ name: 'body', type: 'array', of: [
      { type: 'block' },
      { type: 'image' },
    ]}),
    defineField({ name: 'excerpt', type: 'text' }),
    defineField({ name: 'publishedAt', type: 'datetime' }),
    defineField({ name: 'authors', type: 'array', of: [
      { type: 'reference', to: [{ type: 'author' }] },
    ]}),
    defineField({ name: 'originalUrl', type: 'url' }),
  ],
  preview: { select: { title: 'title', subtitle: 'publishedAt' } },
});

export const tag = defineType({
  name: 'tag',
  title: 'Tag',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string' }),
    defineField({ name: 'slug', type: 'slug', options: { source: 'name', maxLength: 96 } }),
  ],
});

export const category = defineType({
  name: 'category',
  title: 'Category',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string' }),
    defineField({ name: 'slug', type: 'slug', options: { source: 'name', maxLength: 96 } }),
  ],
});

export const author = defineType({
  name: 'author',
  title: 'Author',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string' }),
    defineField({ name: 'slug', type: 'slug', options: { source: 'name', maxLength: 96 } }),
    defineField({ name: 'email', type: 'email' }),
  ],
});
`;
}

// ── NDJSON Writer ────────────────────────────────────────────────────────

export function generateNdjson(
  wxrItems: WxrItem[],
  wxrTags: WxrTag[],
  wxrCategories: WxrCategory[],
  wxrAuthors: Array<{ login: string; displayName: string; email?: string }>,
  _channelInfo: WxrChannelInfo,  idStrategy: IdStrategy = 'prefix',
): SanityNdjsonResult {
  const idMap: Record<string, string> = {};
  const tagMap: Record<string, string> = {};
  const categoryMap: Record<string, string> = {};
  const authorMap: Record<string, string> = {};
  const mediaMap: Record<string, string> = {};
  const documents: SanityDocument[] = [];
  const assetPaths: string[] = [];
  const schemaTypes = new Set<string>();

  // 1. Create taxonomy documents first (reference targets)
  for (const tag of wxrTags) {
    const doc = mapWxrTagToSanity(tag, idMap, idStrategy);
    documents.push(doc);
    tagMap[tag.name] = doc._id;
    schemaTypes.add('tag');
  }

  // Deduplicate tags from items (WXR items may have tags not in top-level wp:tag)
  const itemTags = new Set<string>();
  for (const item of wxrItems) {
    for (const t of item.tags) itemTags.add(t);
  }
  for (const tagName of itemTags) {
    if (!tagMap[tagName]) {
      const doc = mapWxrTagToSanity({ name: tagName }, idMap, idStrategy);
      documents.push(doc);
      tagMap[tagName] = doc._id;
      schemaTypes.add('tag');
    }
  }

  for (const cat of wxrCategories) {
    const doc = mapWxrCategoryToSanity(cat, idMap, idStrategy);
    documents.push(doc);
    categoryMap[cat.name] = doc._id;
    schemaTypes.add('category');
  }

  // Deduplicate categories from items
  const itemCategories = new Set<string>();
  for (const item of wxrItems) {
    for (const c of item.categories) itemCategories.add(c);
  }
  for (const catName of itemCategories) {
    if (!categoryMap[catName]) {
      const doc = mapWxrCategoryToSanity({ name: catName }, idMap, idStrategy);
      documents.push(doc);
      categoryMap[catName] = doc._id;
      schemaTypes.add('category');
    }
  }

  // 2. Create author documents
  for (const author of wxrAuthors) {
    const doc = mapWxrAuthorToSanity(author, idMap, idStrategy);
    documents.push(doc);
    authorMap[author.login || author.displayName] = doc._id;
    schemaTypes.add('author');
  }

  // Deduplicate authors from items
  const itemAuthors = new Set<string>();
  for (const item of wxrItems) {
    if (item.creator) itemAuthors.add(item.creator);
  }
  for (const creatorName of itemAuthors) {
    if (!authorMap[creatorName]) {
      const doc = mapWxrAuthorToSanity(
        { login: wxrSlugify(creatorName), displayName: creatorName },
        idMap,
        idStrategy,
      );
      documents.push(doc);
      authorMap[creatorName] = doc._id;
      schemaTypes.add('author');
    }
  }

  // 3. Register media assets
  for (const item of wxrItems) {
    if (!item.content) continue;
    const imgRe = /src="(https:\/\/images\.squarespace-cdn\.com\/[^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(item.content)) !== null) {
      const url = m[1].replace(/\?format=\w+$/, '');
      const filename = basename(new URL(url).pathname);
      if (!mediaMap[url]) {
        mediaMap[url] = filename;
        assetPaths.push(filename);
      }
    }
  }

  // 4. Create post/page documents (references resolved)
  for (const item of wxrItems) {
    const doc = mapWxrItemToSanity(item, idMap, tagMap, categoryMap, authorMap, mediaMap, idStrategy);
    documents.push(doc);
    schemaTypes.add(item.postType === 'page' ? 'page' : 'post');
  }

  return { documents, idMap, schemaTypes: Array.from(schemaTypes), assetPaths };
}

// ── File Writer ─────────────────────────────────────────────────────────

export function writeSanityOutput(
  manifest: Manifest,
  targetDir: string,
  dryRun: boolean,
  idStrategy: IdStrategy = 'prefix',
): SanityWriteResult {
  const wxrItems = readWxrItems(targetDir);
  if (wxrItems.length === 0) {
    throw new Error('No portage-wxr-items.json found. Run `portage extract` first.');
  }

  // Re-parse the WXR to get tags, categories, authors
  const exportPath = manifest.source.path;
  if (!existsSync(exportPath)) {
    throw new Error(`Source export file not found: ${exportPath}`);
  }
  const xmlContent = readFileSync(exportPath, 'utf-8');

  const wxrResult = parseWxr(xmlContent);

  const result = generateNdjson(
    wxrResult.items,
    wxrResult.tags,
    wxrResult.categories,
    wxrResult.channelInfo.authors,
    wxrResult.channelInfo,
    idStrategy,
  );

  if (dryRun) {
    return {
      documentsWritten: result.documents.length,
      assetsDownloaded: 0,
      schemaTypes: result.schemaTypes.length,
      outputPath: '',
    };
  }

  // Write NDJSON file
  const importDir = resolve(targetDir, 'import');
  mkdirSync(importDir, { recursive: true });

  const ndjsonPath = resolve(importDir, 'data.ndjson');
  const ndjsonLines = result.documents.map((doc) => JSON.stringify(doc));
  writeFileSync(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf-8');

  // Write ID mapping table
  const idMapPath = resolve(targetDir, 'id-map.json');
  writeFileSync(idMapPath, JSON.stringify(result.idMap, null, 2) + '\n', 'utf-8');

  // Write Sanity schema
  const schemaPath = resolve(targetDir, 'sanity-schema.ts');
  writeFileSync(schemaPath, generateSanitySchema(wxrResult.channelInfo), 'utf-8');

  // Create assets directory
  const assetsDir = resolve(importDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });

  // Write .env with Sanity project info
  const envPath = resolve(targetDir, '.env');
  if (!existsSync(envPath)) {
    writeFileSync(envPath, 'SANITY_PROJECT_ID=your-project-id\nSANITY_DATASET=production\n', 'utf-8');
  }

  return {
    documentsWritten: result.documents.length,
    assetsDownloaded: result.assetPaths.length,
    schemaTypes: result.schemaTypes.length,
    outputPath: ndjsonPath,
  };
}

// ── Squarespace CDN Image Download for Sanity ──────────────────────────

export async function downloadSqspImagesForSanity(
  manifest: Manifest,
  targetDir: string,
  dryRun: boolean,
): Promise<BatchDownloadResult> {
  return downloadAllRemoteImages(manifest, targetDir, dryRun, 'import/assets', sqspUrlTransform, sqspFilenameTransform);
}

// ── Feature Mapping ────────────────────────────────────────────────────

export interface SquarespaceSanityFeatureResult { mapped: number; unmapped: string[] }

export function mapSquarespaceFeaturesToSanity(plugins: Array<{ gatsbyPlugin: string }>): SquarespaceSanityFeatureResult {
  const sanityMappings: Record<string, string | undefined> = {
    'blog': 'post schema type',
    'sitemap': undefined,
    'url-mappings': undefined,
    'gallery-block': 'image array field',
    'summary-block': undefined,
    'form-block': undefined,
    'store-page': undefined,
  };

  let mapped = 0;
  const unmapped: string[] = [];
  for (const plugin of plugins) {
    const eq = sanityMappings[plugin.gatsbyPlugin];
    if (eq) { mapped++; }
    else { unmapped.push(plugin.gatsbyPlugin); }
  }
  return { mapped, unmapped };
}
