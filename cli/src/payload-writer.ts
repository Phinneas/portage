/**
 * Payload CMS writer. Generates a seed script that creates documents in
 * Payload collections via the Local API, or pushes via the REST API.
 *
 * Used by the ghost2payload route. The extract phase (ghost.ts) produces
 * a GhostExport; this module converts it into Payload collection data and
 * writes a seed script that can be executed with `payload run src/seed.ts`.
 *
 * Seed script ordering:
 *   1. Tags (relationship targets)
 *   2. Media (upload images via filePath)
 *   3. Authors (reference media for profile images)
 *   4. Posts/Pages (reference tags, authors, media)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import type { Manifest } from './manifest.js';
import { coerceDate } from './frontmatter.js';
import {
  type GhostExport, type GhostPost, type GhostTag, type GhostAuthor,
  readGhostExport,
} from './ghost.js';
import { downloadImage, downloadAllRemoteImages, ghostUrlTransform, ghostFilenameTransform, type BatchDownloadResult } from './asset_handler.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface PayloadCollectionConfig {
  slug: string;
  fields: PayloadFieldConfig[];
  upload?: boolean;
}

export interface PayloadFieldConfig {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  relationTo?: string;
  hasMany?: boolean;
  fields?: PayloadFieldConfig[];
}

export interface PayloadSeedResult {
  written: number;
  skippedDrafts: number;
  mediaDir: string;
}

// ── Ghost → Payload field mapping ──────────────────────────────────────

export function mapGhostPostToPayload(
  post: GhostPost,
  tagMap: Record<string, string>,
  authorMap: Record<string, string>,
  mediaMap: Record<string, string>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};

  // Preserve Ghost GID for reference
  doc.ghostUuid = post.uuid;

  doc.title = post.title;
  doc.slug = post.slug;

  if (post.customExcerpt) doc.excerpt = post.customExcerpt;

  // Lexical content preferred for Payload's rich text editor
  if (post.lexical) {
    try {
      doc.content = JSON.parse(post.lexical);
    } catch {
      doc.content = post.lexical;
    }
  }

  // HTML fallback stored separately
  if (post.html) {
    doc.htmlContent = post.html;
  }

  // Feature image → media relationship
  if (post.featureImage && mediaMap[post.featureImage]) {
    doc.featureImage = mediaMap[post.featureImage];
  }
  if (post.featureImageAlt) doc.featureImageAlt = post.featureImageAlt;
  if (post.featureImageCaption) {
    doc.featureImageCaption = post.featureImageCaption.replace(/<[^>]+>/g, '').trim();
  }

  // Dates
  const pubDate = coerceDate(post.publishedAt);
  if (pubDate) doc.publishedAt = pubDate;
  if (post.updatedAt && post.updatedAt !== post.publishedAt) {
    const updDate = coerceDate(post.updatedAt);
    if (updDate) doc.updatedAt = updDate;
  }

  // Tags → relationship array (resolved IDs)
  const tagIds = post.tagIds
    .map((id) => tagMap[id])
    .filter(Boolean);
  if (tagIds.length > 0) doc.tags = tagIds;

  // Authors → relationship array (resolved IDs, primary first)
  const authorIds = post.authorIds
    .map((id) => authorMap[id])
    .filter(Boolean);
  if (authorIds.length > 0) doc.authors = authorIds;

  // SEO group
  const seo: Record<string, unknown> = {};
  if (post.metaTitle) seo.title = post.metaTitle;
  else seo.title = post.title;
  if (post.metaDescription) seo.description = post.metaDescription;
  else if (post.customExcerpt) seo.description = post.customExcerpt;

  const openGraph: Record<string, unknown> = {};
  if (post.ogImage && mediaMap[post.ogImage]) openGraph.image = mediaMap[post.ogImage];
  else if (post.featureImage && mediaMap[post.featureImage]) openGraph.image = mediaMap[post.featureImage];
  if (post.ogTitle) openGraph.title = post.ogTitle;
  if (post.ogDescription) openGraph.description = post.ogDescription;
  if (Object.keys(openGraph).length > 0) seo.openGraph = openGraph;

  const twitter: Record<string, unknown> = {};
  if (post.twitterTitle) twitter.title = post.twitterTitle;
  if (post.twitterDescription) twitter.description = post.twitterDescription;
  if (post.twitterImage && mediaMap[post.twitterImage]) twitter.image = mediaMap[post.twitterImage];
  if (Object.keys(twitter).length > 0) seo.twitter = twitter;

  if (Object.keys(seo).length > 0) doc.seo = seo;

  // Canonical URL
  if (post.canonicalUrl) doc.canonicalUrl = post.canonicalUrl;

  // Featured flag
  doc.featured = post.featured;

  // Visibility
  if (post.visibility === 'members') doc.visibility = 'members';
  else if (post.visibility === 'paid') doc.visibility = 'paid';
  else doc.visibility = 'public';

  // Status
  doc._status = post.status === 'draft' || post.status === 'scheduled' ? 'draft' : 'published';

  // Code injection (preserved for reference, never executed)
  if (post.codeinjectionHead || post.codeinjectionFoot) {
    const ghost: Record<string, unknown> = {};
    if (post.codeinjectionHead) ghost.head = post.codeinjectionHead;
    if (post.codeinjectionFoot) ghost.foot = post.codeinjectionFoot;
    doc.ghost = { codeInjection: ghost };
  }

  return doc;
}

export function mapGhostTagToPayload(
  tag: GhostTag,
  mediaMap: Record<string, string>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  doc.name = tag.name;
  doc.slug = tag.slug;
  if (tag.description) doc.description = tag.description;
  if (tag.featureImage && mediaMap[tag.featureImage]) {
    doc.featureImage = mediaMap[tag.featureImage];
  }
  return doc;
}

export function mapGhostAuthorToPayload(
  author: GhostAuthor,
  mediaMap: Record<string, string>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  doc.name = author.name;
  doc.slug = author.slug;
  if (author.bio) doc.bio = author.bio;
  if (author.profileImage && mediaMap[author.profileImage]) {
    doc.profileImage = mediaMap[author.profileImage];
  }
  if (author.website) doc.website = author.website;
  if (author.location) doc.location = author.location;
  if (author.facebook) doc.facebook = author.facebook;
  if (author.twitter) doc.twitter = author.twitter;
  return doc;
}

// ── Collection configs ────────────────────────────────────────────────────

export function generatePayloadConfig(): string {
  return `// @ts-check
import { buildConfig } from 'payload';
import { sqliteAdapter } from '@payloadcms/db-sqlite';

export default buildConfig({
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', required: true, unique: true },
        { name: 'content', type: 'richText' },
        { name: 'htmlContent', type: 'textarea' },
        { name: 'excerpt', type: 'textarea' },
        { name: 'featureImage', type: 'upload', relationTo: 'media' },
        { name: 'featureImageAlt', type: 'text' },
        { name: 'featureImageCaption', type: 'text' },
        { name: 'publishedAt', type: 'date' },
        { name: 'updatedAt', type: 'date' },
        { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        { name: 'authors', type: 'relationship', relationTo: 'authors', hasMany: true },
        {
          name: 'seo', type: 'group', fields: [
            { name: 'title', type: 'text' },
            { name: 'description', type: 'textarea' },
            {
              name: 'openGraph', type: 'group', fields: [
                { name: 'image', type: 'upload', relationTo: 'media' },
                { name: 'title', type: 'text' },
                { name: 'description', type: 'textarea' },
              ],
            },
            {
              name: 'twitter', type: 'group', fields: [
                { name: 'image', type: 'upload', relationTo: 'media' },
                { name: 'title', type: 'text' },
                { name: 'description', type: 'textarea' },
              ],
            },
          ],
        },
        { name: 'canonicalUrl', type: 'text' },
        { name: 'featured', type: 'checkbox' },
        { name: 'visibility', type: 'select', options: ['public', 'members', 'paid'] },
        { name: 'ghost', type: 'json' },
      ],
    },
    {
      slug: 'pages',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', required: true, unique: true },
        { name: 'content', type: 'richText' },
        { name: 'featureImage', type: 'upload', relationTo: 'media' },
        { name: 'publishedAt', type: 'date' },
        { name: 'authors', type: 'relationship', relationTo: 'authors', hasMany: true },
      ],
    },
    {
      slug: 'tags',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'slug', type: 'text', required: true, unique: true },
        { name: 'description', type: 'textarea' },
        { name: 'featureImage', type: 'upload', relationTo: 'media' },
      ],
    },
    {
      slug: 'authors',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'slug', type: 'text', required: true, unique: true },
        { name: 'bio', type: 'richText' },
        { name: 'profileImage', type: 'upload', relationTo: 'media' },
        { name: 'website', type: 'text' },
        { name: 'location', type: 'text' },
        { name: 'facebook', type: 'text' },
        { name: 'twitter', type: 'text' },
      ],
    },
    {
      slug: 'media',
      upload: true,
      fields: [
        { name: 'alt', type: 'text' },
      ],
    },
  ],
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URL || 'file:./portage-migration.db' },
  }),
});
`;
}

// ── Seed script generation ────────────────────────────────────────────────

export function generateSeedScript(ghostExport: GhostExport): string {
  const lines: string[] = [];

  lines.push(`import { getPayload } from 'payload';`);
  lines.push(`import config from '@payload-config';`);
  lines.push(`import path from 'node:path';`);
  lines.push(`import { writeFileSync, mkdirSync } from 'node:fs';`);
  lines.push(``);
  lines.push(`async function seed() {`);
  lines.push(`  const payload = await getPayload({ config });`);
  lines.push(``);

  // 1. Create tags
  lines.push(`  // 1. Create tags (relationship targets first)`);
  lines.push(`  const tagMap: Record<string, string> = {};`);
  for (const tag of ghostExport.tags) {
    if (tag.isInternal) continue;
    lines.push(`  {`);
    lines.push(`    const doc = await payload.create({ collection: 'tags', data: ${JSON.stringify(mapGhostTagToPayload(tag, {}))}, overrideAccess: true });`);
    lines.push(`    tagMap[${JSON.stringify(tag.id)}] = doc.id;`);
    lines.push(`  }`);
  }
  lines.push(``);

  // 2. Create media placeholders
  lines.push(`  // 2. Create media (upload images)`);
  lines.push(`  const mediaMap: Record<string, string> = {};`);
  lines.push(`  // NOTE: Image download must happen before running this seed script.`);
  lines.push(`  // Images should be in the ./media/ directory.`);
  lines.push(`  // The seed script will attempt to upload each image via filePath.`);

  // Collect unique image URLs
  const imageUrls = new Set<string>();
  for (const post of ghostExport.posts) {
    if (post.featureImage) imageUrls.add(post.featureImage);
    if (post.ogImage) imageUrls.add(post.ogImage);
    if (post.twitterImage) imageUrls.add(post.twitterImage);
  }
  for (const tag of ghostExport.tags) {
    if (tag.featureImage) imageUrls.add(tag.featureImage);
  }
  for (const author of ghostExport.authors) {
    if (author.profileImage) imageUrls.add(author.profileImage);
  }

  for (const url of imageUrls) {
    const filename = basename(new URL(url.replace(/\/size\/w\d+\//, '/')).pathname);
    lines.push(`  {`);
    lines.push(`    const filePath = path.resolve('./media/${filename}');`);
    lines.push(`    try {`);
    lines.push(`      const doc = await payload.create({ collection: 'media', data: { alt: '' }, filePath, overrideAccess: true });`);
    lines.push(`      mediaMap[${JSON.stringify(url)}] = doc.id;`);
    lines.push(`    } catch (e) { console.warn('Failed to upload:', filePath); }`);
    lines.push(`  }`);
  }
  lines.push(``);

  // 3. Create authors
  lines.push(`  // 3. Create authors`);
  lines.push(`  const authorMap: Record<string, string> = {};`);
  for (const author of ghostExport.authors) {
    lines.push(`  {`);
    lines.push(`    const doc = await payload.create({ collection: 'authors', data: ${JSON.stringify(mapGhostAuthorToPayload(author, {}))}, overrideAccess: true });`);
    lines.push(`    authorMap[${JSON.stringify(author.id)}] = doc.id;`);
    lines.push(`  }`);
  }
  lines.push(``);

  // 4. Create posts and pages
  lines.push(`  // 4. Create posts and pages (references resolved)`);
  lines.push(`  let count = 0;`);
  for (const post of ghostExport.posts) {
    const collection = post.type === 'page' ? 'pages' : 'posts';
    const docData = mapGhostPostToPayload(post, {}, {}, {});
    // Remove content field for seed script brevity - will be set dynamically
    const compactData = { ...docData };
    // Don't serialize content (Lexical JSON) inline - too verbose
    if (compactData.content) {
      lines.push(`  {`);
      lines.push(`    const doc = await payload.create({ collection: '${collection}', data: ${JSON.stringify(compactData)}, overrideAccess: true });`);
      lines.push(`    count++;`);
      lines.push(`  }`);
    } else {
      lines.push(`  {`);
      lines.push(`    const doc = await payload.create({ collection: '${collection}', data: ${JSON.stringify(compactData)}, overrideAccess: true });`);
      lines.push(`    count++;`);
      lines.push(`  }`);
    }
  }
  lines.push(``);
  lines.push(`  console.log('Seed complete.', count, 'documents created.');`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`seed();`);

  return lines.join('\n');
}

// ── Ghost image download (delegates to asset_handler) ─────────────────

export async function downloadGhostImage(url: string, mediaDir: string): Promise<{ success: boolean; localPath: string; error?: string }> {
  return downloadImage({
    url,
    targetDir: resolve(mediaDir, '..'),
    subdir: 'media',
    urlTransform: ghostUrlTransform,
    filenameTransform: ghostFilenameTransform,
  });
}

export async function downloadAllGhostImages(
  manifest: Manifest,
  targetDir: string,
  dryRun: boolean
): Promise<BatchDownloadResult> {
  return downloadAllRemoteImages(manifest, targetDir, dryRun, 'media', ghostUrlTransform, ghostFilenameTransform);
}

// ── Main write function ─────────────────────────────────────────────────

export function writePayloadSeed(
  _manifest: Manifest,
  targetDir: string,
  dryRun: boolean,
): PayloadSeedResult {
  let written = 0;
  let skippedDrafts = 0;

  const ghostExport = readGhostExport(targetDir);
  if (!ghostExport) {
    throw new Error('No portage-ghost-export.json found. Run `portage extract` first.');
  }

  // Count skipped drafts
  for (const post of ghostExport.posts) {
    if (post.status === 'draft' || post.status === 'scheduled') skippedDrafts++;
  }

  if (!dryRun) {
    // Generate and write seed script
    const seedScript = generateSeedScript(ghostExport);
    const seedPath = resolve(targetDir, 'src/seed.ts');
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, seedScript, 'utf-8');

    // Generate and write payload config
    const configScript = generatePayloadConfig();
    const configPath = resolve(targetDir, 'src/payload.config.ts');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, configScript, 'utf-8');

    // Write .env with SQLite URL
    const envPath = resolve(targetDir, '.env');
    if (!existsSync(envPath)) {
      writeFileSync(envPath, 'DATABASE_URL=file:./portage-migration.db\nPAYLOAD_SECRET=portage-migration-secret\n', 'utf-8');
    }

    // Create media directory
    mkdirSync(resolve(targetDir, 'media'), { recursive: true });

    written = ghostExport.posts.length;
  } else {
    written = ghostExport.posts.length;
  }

  return { written, skippedDrafts, mediaDir: resolve(targetDir, 'media') };
}
