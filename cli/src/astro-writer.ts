/**
 * Astro project writer: MDX rewriting, content collection output,
 * asset localization, redirect generation, and config writing.
 * Owns everything about *writing* an Astro project.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import type { Manifest } from './manifest.js';
import {
  splitFrontmatter, serializeFrontmatter, FIELD_MAP, FIELD_KEY_MAP,
  coerceDate, ensureArray, coerceBoolean,
} from './frontmatter.js';
import { deriveSlug } from './gatsby.js';
import { deriveSlug as deriveJekyllSlug, JEKYLL_FIELD_KEY_MAP, convertLiquidTags, parsePostFilename } from './jekyll.js';
import { mapSquarespaceFrontmatter, convertHtmlToMarkdown, deriveSlug as deriveSqSlug, readWxrItems } from './squarespace.js';
import { mapSubstackFrontmatter, convertHtmlToMarkdown as convertSubstackHtml, readSubstackPosts } from './substack.js';
import { mapNextFrontmatter, rewriteNextLink, rewriteNextImage, rewriteNextHead, deriveSlug as deriveNextSlug } from './next.js';
import { mapGhostFrontmatter, readGhostExport } from './ghost.js';
import { convertHtmlToMarkdown as convertGhostHtml } from './block_parser.js';

// ── MDX rewriting ─────────────────────────────────────────────────────

export interface Rewrite { type: 'link' | 'gatsby-image' | 'static-image' | 'import'; from: string; to: string }

export function rewriteMdx(filePath: string): Rewrite[] {
  const rewrites: Rewrite[] = [];
  let content: string;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return rewrites; }

  let modified = content;

  // <Link to="/path"> → <a href="/path">
  modified = modified.replace(/<Link\s+to=["']([^"']+)["']([^>]*)>/g, (_m, href, rest) => {
    rewrites.push({ type: 'link', from: `<Link to="${href}">`, to: `<a href="${href}">` });
    return `<a href="${href}"${rest}>`;
  });
  modified = modified.replace(/<\/Link>/g, '</a>');

  // <GatsbyImage image={data} alt="..." /> → <Image src={...} alt="..." />
  modified = modified.replace(/<GatsbyImage\s+image=\{([^}]+)\}\s+alt=["']([^"']+)["']([^/]*)\/>/g, (_m, imgData, alt, rest) => {
    rewrites.push({ type: 'gatsby-image', from: `<GatsbyImage>`, to: `<Image>` });
    return `<Image src=${simplifyGatsbyImageData(imgData)}} alt="${alt}"${rest} />`;
  });

  // <StaticImage src="..." alt="..." /> → <Image src="..." alt="..." />
  modified = modified.replace(/<StaticImage\s+src=["']([^"']+)["']\s+alt=["']([^"']+)["']([^/]*)\/>/g, (_m, src, alt, rest) => {
    rewrites.push({ type: 'static-image', from: `<StaticImage>`, to: `<Image>` });
    return `<Image src="${src}" alt="${alt}"${rest} />`;
  });

  // Remove Gatsby imports
  modified = modified.replace(/import\s+\{?\s*Link\s*\}?\s+from\s+['"]gatsby['"]\s*;?\n?/g, (m) => {
    rewrites.push({ type: 'import', from: m.trim(), to: '(removed)' });
    return '';
  });
  modified = modified.replace(/import\s+\{?\s*(?:GatsbyImage|StaticImage)\s*\}?\s+from\s+['"]gatsby-plugin-image['"]\s*;?\n?/g, (m) => {
    rewrites.push({ type: 'import', from: m.trim(), to: 'import { Image } from "astro:assets"' });
    return '';
  });

  if (modified !== content) {
    try { writeFileSync(filePath, modified, 'utf-8'); } catch { /* skip */ }
  }
  return rewrites;
}

function simplifyGatsbyImageData(expr: string): string {
  if (expr.includes('gatsbyImageData') || expr.includes('childImageSharp')) {
    return expr.replace(/\.childImageSharp\.gatsbyImageData/, '');
  }
  return expr;
}

// ── Content transform (field mapping) ───────────────────────────────────

export interface TransformResult {
  mapped: number;
  rewrites: Array<{ file: string; type: 'link' | 'image' | 'plugin' | 'fragment' | 'other'; from: string; to: string }>;
}

export function transformContent(manifest: Manifest): TransformResult {
  let mapped = 0;
  const rewrites: TransformResult['rewrites'] = [];

  for (const file of manifest.extract.contentFiles) {
    try {
      const raw = readFileSync(file.absolutePath, 'utf-8');
      const parsed = splitFrontmatter(raw);
      if (!parsed) continue;
      const { frontmatter, body } = parsed;

      const astroFm: Record<string, unknown> = {};
      const gatsbyNs: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(frontmatter)) {
        const mapping = FIELD_MAP[key];
        if (mapping) {
          const transformed = mapping.transform ? mapping.transform(value) : value;
          if (mapping.astro !== '_slug') setNestedKey(astroFm, mapping.astro, transformed);
          mapped++;
        } else if (key.startsWith('seo.')) {
          if (!astroFm.seo) astroFm.seo = {};
          (astroFm.seo as Record<string, unknown>)[key.replace('seo.', '')] = value;
          mapped++;
        } else {
          gatsbyNs[key] = value;
        }
      }

      // Inject GraphQL-sourced fields
      for (const query of manifest.extract.queries) {
        for (const field of query.fields) {
          if (field.startsWith('fields.') && !FIELD_MAP[field]) {
            gatsbyNs[`gatsby:${field.replace('fields.', '')}`] = `from query in ${query.sourceFile}`;
          }
        }
      }

      // Merge gatsby: namespace
      for (const [k, v] of Object.entries(gatsbyNs)) {
        astroFm[k.startsWith('gatsby:') ? k : `gatsby:${k}`] = v;
      }

      // Track rewrites
      if (/<Link\s+to=/.test(body)) rewrites.push({ file: file.relativePath, type: 'link', from: '<Link>', to: '<a>' });
      if (/<GatsbyImage|<StaticImage/.test(body)) rewrites.push({ file: file.relativePath, type: 'image', from: '<GatsbyImage>/<StaticImage>', to: '<Image>' });
    } catch { /* skip */ }
  }

  return { mapped, rewrites };
}

function setNestedKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key.includes('.')) {
    const parts = key.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  } else {
    obj[key] = value;
  }
}

// ── Collection writer ────────────────────────────────────────────────────

export interface CollectionResult { written: number; skippedDrafts: number }

export function writeCollections(manifest: Manifest, targetDir: string, dryRun: boolean): CollectionResult {
  let written = 0;
  let skippedDrafts = 0;
  const isJekyll = manifest.source.platform === 'jekyll';
  const isNext = manifest.source.platform === 'next';

  const blogDir = resolve(targetDir, 'src/content/blog');
  const pagesDir = resolve(targetDir, 'src/content/pages');
  const assetsDir = resolve(targetDir, 'src/assets/blog');

  if (!dryRun) {
    mkdirSync(blogDir, { recursive: true });
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
  }

  for (const file of manifest.extract.contentFiles) {
    try {
      const raw = readFileSync(file.absolutePath, 'utf-8');
      const parsed = splitFrontmatter(raw);
      const fm = parsed?.frontmatter || {};

      // Jekyll: published:false → draft:true
      if (isJekyll && fm.published === false) fm.draft = true;
      if (fm.draft === true || fm.draft === 'true') skippedDrafts++;

      const astroFm = isJekyll ? mapJekyllFrontmatter(fm) : isNext ? mapNextFrontmatter(fm) : mapFrontmatter(fm);
      if (astroFm.heroImage) astroFm.heroImage = rewriteImagePath(String(astroFm.heroImage));

      // Jekyll: inject date from filename if not in frontmatter
      if (isJekyll && !astroFm.pubDate) {
        const { date } = parsePostFilename(file.relativePath);
        if (date) astroFm.pubDate = date;
      }

      const slug = isJekyll ? deriveJekyllSlug(file.relativePath) : isNext ? deriveNextSlug(file.absolutePath, manifest.source.path) : deriveSlug(file.relativePath);

      // Determine output directory — Jekyll custom collections get their own dirs
      let outDir: string;
      if (file.collection === 'pages') {
        outDir = pagesDir;
      } else if (file.collection === 'blog' || file.collection === 'unknown') {
        outDir = blogDir;
      } else {
        // Custom collection (e.g. "projects")
        outDir = resolve(targetDir, `src/content/${file.collection}`);
        if (!dryRun) mkdirSync(outDir, { recursive: true });
      }

      const ext = file.format === 'mdx' ? '.mdx' : '.md';
      const outPath = resolve(outDir, `${slug}${ext}`);

      let body = parsed?.body || '';
      // Jekyll: convert Liquid tags in body
      if (isJekyll) body = convertLiquidTags(body);
      // Next.js: rewrite next/link, next/image, next/head
      if (isNext) {
        body = rewriteNextLink(body);
        body = rewriteNextImage(body);
        body = rewriteNextHead(body);
      }

      if (!dryRun) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, serializeFrontmatter(astroFm) + body, 'utf-8');
      }
      written++;
    } catch { /* skip */ }
  }

  if (!dryRun) {
    writeContentConfig(targetDir, manifest);
    writeAstroConfig(targetDir, manifest);
  }
  return { written, skippedDrafts };
}

function mapFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const astro: Record<string, unknown> = {};

  for (const [gatsbyKey, astroKey] of Object.entries(FIELD_KEY_MAP)) {
    if (fm[gatsbyKey] === undefined) continue;
    let value: unknown = fm[gatsbyKey];

    if (astroKey === 'pubDate' || astroKey === 'updatedDate') {
      const d = coerceDate(value);
      value = d ?? undefined;
      if (value === undefined) continue;
    }
    if (astroKey === 'draft') value = coerceBoolean(value);
    if (astroKey === 'authors' && gatsbyKey === 'author') value = ensureArray(value);
    else if (astroKey === 'categories' && gatsbyKey === 'category') value = ensureArray(value);
    else if (['authors', 'tags', 'categories'].includes(astroKey)) value = ensureArray(value);

    astro[astroKey] = value;
  }

  if (fm.seo && typeof fm.seo === 'object') astro.seo = fm.seo;

  const knownKeys = new Set(Object.keys(FIELD_KEY_MAP));
  for (const [k, v] of Object.entries(fm)) {
    if (!knownKeys.has(k) && k !== 'seo') astro[`gatsby:${k}`] = v;
  }

  return astro;
}

function mapJekyllFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const astro: Record<string, unknown> = {};

  for (const [jekyllKey, astroKey] of Object.entries(JEKYLL_FIELD_KEY_MAP)) {
    if (fm[jekyllKey] === undefined) continue;
    if (astroKey.startsWith('_')) {
      // Preserved in jekyll: namespace (layout, permalink)
      astro[`jekyll:${jekyllKey}`] = fm[jekyllKey];
      continue;
    }
    let value: unknown = fm[jekyllKey];

    if (astroKey === 'pubDate' || astroKey === 'updatedDate') {
      const d = coerceDate(value);
      value = d ?? undefined;
      if (value === undefined) continue;
    }
    // published:false → draft:true
    if (astroKey === 'draft' && jekyllKey === 'published') {
      value = !coerceBoolean(value); // invert: published=false → draft=true
    } else if (astroKey === 'draft') {
      value = coerceBoolean(value);
    }
    if (astroKey === 'authors' && jekyllKey === 'author') value = ensureArray(value);
    else if (astroKey === 'tags') {
      // Merge categories + tags
      const tags = ensureArray(value);
      const existing = astro.tags as unknown[] || [];
      value = [...new Set([...existing, ...tags])];
    }
    if (['authors', 'tags'].includes(astroKey) && !jekyllKey.startsWith('categor')) value = ensureArray(value);

    astro[astroKey] = value;
  }

  // Carry seo fields
  if (fm.seo && typeof fm.seo === 'object') astro.seo = fm.seo;

  // Unknown keys → jekyll: namespace
  const knownKeys = new Set(Object.keys(JEKYLL_FIELD_KEY_MAP));
  for (const [k, v] of Object.entries(fm)) {
    if (!knownKeys.has(k) && k !== 'seo') astro[`jekyll:${k}`] = v;
  }

  return astro;
}

// ── Squarespace collection writer ────────────────────────────────────────

export interface SqCollectionResult { written: number; skippedDrafts: number }

export function writeSquarespaceCollections(manifest: Manifest, targetDir: string, dryRun: boolean, heroStrategy: 'first-image' | 'none' = 'first-image'): SqCollectionResult {
  let written = 0;
  let skippedDrafts = 0;

  const blogDir = resolve(targetDir, 'src/content/blog');
  const pagesDir = resolve(targetDir, 'src/content/pages');
  const assetsDir = resolve(targetDir, 'src/assets/blog');

  if (!dryRun) {
    mkdirSync(blogDir, { recursive: true });
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
  }

  const items = readWxrItems(targetDir);
  for (const item of items) {
    if (item.status === 'draft') {
      skippedDrafts++;
    }

    const astroFm = mapSquarespaceFrontmatter(item, heroStrategy);
    const slug = deriveSqSlug(item);
    const outDir = item.postType === 'page' ? pagesDir : blogDir;
    const body = convertHtmlToMarkdown(item.content);
    const outPath = resolve(outDir, `${slug}.md`);

    if (!dryRun) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, serializeFrontmatter(astroFm) + body, 'utf-8');
    }
    written++;
  }

  if (!dryRun) {
    writeContentConfig(targetDir, manifest);
    writeAstroConfig(targetDir, manifest);
  }
  return { written, skippedDrafts };
}

// ── Substack collection writer ──────────────────────────────────────────

export interface SubstackCollectionResult { written: number; skippedDrafts: number }

export function writeSubstackCollections(manifest: Manifest, targetDir: string, dryRun: boolean, heroStrategy: 'first-image' | 'none' = 'first-image'): SubstackCollectionResult {
  let written = 0;
  let skippedDrafts = 0;

  const blogDir = resolve(targetDir, 'src/content/blog');
  const pagesDir = resolve(targetDir, 'src/content/pages');
  const podcastDir = resolve(targetDir, 'src/content/podcast');
  const threadsDir = resolve(targetDir, 'src/content/threads');
  const assetsDir = resolve(targetDir, 'src/assets/blog');

  if (!dryRun) {
    mkdirSync(blogDir, { recursive: true });
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(podcastDir, { recursive: true });
    mkdirSync(threadsDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
  }

  const posts = readSubstackPosts(targetDir);
  for (const post of posts) {
    if (!post.isPublished) {
      skippedDrafts++;
    }

    const astroFm = mapSubstackFrontmatter(post, heroStrategy);
    const slug = post.slug;
    const collection = post.type === 'page' ? 'pages' : post.type === 'podcast' ? 'podcast' : post.type === 'thread' ? 'threads' : 'blog';
    const outDir = collection === 'pages' ? pagesDir : collection === 'podcast' ? podcastDir : collection === 'threads' ? threadsDir : blogDir;
    const body = convertSubstackHtml(post.html);
    const outPath = resolve(outDir, `${slug}.md`);

    if (!dryRun) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, serializeFrontmatter(astroFm) + body, 'utf-8');
    }
    written++;
  }

  if (!dryRun) {
    writeContentConfig(targetDir, manifest);
    writeAstroConfig(targetDir, manifest);
  }
  return { written, skippedDrafts };
}

// ── Ghost → Astro collection writer ────────────────────────────────────

export interface GhostCollectionResult {
  written: number;
  skippedDrafts: number;
  lexicalFlagged: number;
}

export function writeGhostCollections(
  manifest: Manifest,
  targetDir: string,
  dryRun: boolean,
  heroStrategy: 'first-image' | 'none' = 'first-image',
): GhostCollectionResult {
  let written = 0;
  let skippedDrafts = 0;
  let lexicalFlagged = 0;

  const ghostExport = readGhostExport(targetDir);
  if (!ghostExport) {
    throw new Error('No portage-ghost-export.json found. Run `portage extract` first.');
  }

  const blogDir = resolve(targetDir, 'src/content/blog');
  const pagesDir = resolve(targetDir, 'src/content/pages');
  const assetsDir = resolve(targetDir, 'src/assets/blog');

  if (!dryRun) {
    mkdirSync(blogDir, { recursive: true });
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
  }

  // Build lookup maps: tag ID → name, author ID → name
  const tagNameMap = new Map<string, string>();
  for (const tag of ghostExport.tags) tagNameMap.set(tag.id, tag.name);

  const authorNameMap = new Map<string, string>();
  for (const author of ghostExport.authors) authorNameMap.set(author.id, author.name);

  for (const post of ghostExport.posts) {
    if (post.status === 'draft' || post.status === 'scheduled') {
      skippedDrafts++;
    }

    const tagNames = post.tagIds.map((id) => tagNameMap.get(id)).filter(Boolean) as string[];
    const authorNames = post.authorIds.map((id) => authorNameMap.get(id)).filter(Boolean) as string[];

    const astroFm = mapGhostFrontmatter(post, tagNames, authorNames, heroStrategy);

    // Flag Lexical content for manual review (Astro uses HTML, not Lexical)
    if (post.hasLexical) {
      astroFm.lexicalReview = true;
      lexicalFlagged++;
    }

    const slug = post.slug;
    const collection = post.type === 'page' ? 'pages' : 'blog';
    const outDir = collection === 'pages' ? pagesDir : blogDir;
    const body = convertGhostHtml(post.html, 'generic');
    const outPath = resolve(outDir, `${slug}.md`);

    if (!dryRun) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, serializeFrontmatter(astroFm) + body, 'utf-8');
    }
    written++;
  }

  if (!dryRun) {
    writeContentConfig(targetDir, manifest);
    writeAstroConfig(targetDir, manifest);
  }

  return { written, skippedDrafts, lexicalFlagged };
}

function rewriteImagePath(imagePath: string): string {
  if (imagePath.startsWith('src/images/')) return `../../assets/blog/${imagePath.replace(/^src\/images\//, '')}`;
  if (imagePath.startsWith('static/')) return imagePath.replace(/^static\//, '/');
  // Jekyll-style absolute paths: /assets/images/X, /images/X, assets/images/X, images/X
  // All map to ../../assets/blog/X (just the filename, subdirs flattened)
  const filename = imagePath.split('/').pop();
  if (filename) return `../../assets/blog/${filename}`;
  return imagePath;
}

function writeContentConfig(targetDir: string, manifest: Manifest): void {
  const collections: string[] = [];
  if (manifest.extract.counts.posts > 0) collections.push('blog');
  if (manifest.extract.counts.pages > 0) collections.push('pages');

  // Discover custom collections (Jekyll collections like "projects", "team", etc.)
  const customCollections = new Set<string>();
  for (const file of manifest.extract.contentFiles) {
    if (file.collection !== 'blog' && file.collection !== 'pages' && file.collection !== 'unknown') {
      customCollections.add(file.collection);
    }
  }
  for (const col of customCollections) {
    if (!collections.includes(col)) collections.push(col);
  }

  const imports = `import { defineCollection, z } from 'astro:content';\nimport { glob } from 'astro/loaders';`;
  const defs = collections.map((name) => {
    const schema = name === 'blog' ? BLOG_SCHEMA : name === 'pages' ? PAGES_SCHEMA : CUSTOM_SCHEMA;
    return `
const ${name} = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/${name}' }),
  schema: ${name === 'blog' || name === 'pages' ? '({ image }) => z.object({\n' + schema + '\n  })' : 'z.object({\n' + schema + '\n  })'},
});`;
  }).join('\n');
  const exports = `export const collections = { ${collections.join(', ')} };`;
  const config = `${imports}\n${defs}\n${exports}\n`;

  const configPath = resolve(targetDir, 'src/content.config.ts');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, config, 'utf-8');
}

const BLOG_SCHEMA = [
  '    title: z.string(),',
  '    description: z.string().optional(),',
  '    pubDate: z.coerce.date(),',
  '    updatedDate: z.coerce.date().optional(),',
  '    heroImage: image().optional(),',
  '    heroImageAlt: z.string().optional(),',
  '    tags: z.array(z.string()).default([]),',
  '    categories: z.array(z.string()).default([]),',
  '    authors: z.array(z.string()).default([]),',
  '    draft: z.boolean().default(false),',
  '    canonicalURL: z.string().url().optional(),',
  '    readingTime: z.number().optional(),',
  '    timeToRead: z.number().optional(),',
  '    seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),',
].join('\n');

const PAGES_SCHEMA = [
  '    title: z.string(),',
  '    description: z.string().optional(),',
  '    pubDate: z.coerce.date().optional(),',
  '    updatedDate: z.coerce.date().optional(),',
  '    heroImage: image().optional(),',
  '    draft: z.boolean().default(false),',
].join('\n');

const CUSTOM_SCHEMA = [
  '    title: z.string(),',
  '    description: z.string().optional(),',
  '    tags: z.array(z.string()).default([]),',
  '    draft: z.boolean().default(false),',
].join('\n');

function writeAstroConfig(targetDir: string, manifest: Manifest): void {
  const configPath = resolve(targetDir, 'astro.config.mjs');
  if (existsSync(configPath)) return; // Don't overwrite existing config

  const hasMdx = manifest.extract.contentFiles.some((f) => f.format === 'mdx');
  const hasSitemap = manifest.extract.plugins.some((p) => p.gatsbyPlugin === 'gatsby-plugin-sitemap' || p.gatsbyPlugin === 'jekyll-sitemap');

  // Read Ghost settings if available for site metadata
  let siteUrl = 'https://example.com';
  let siteTitle = '';
  let siteDescription = '';
  if (manifest.source.platform === 'ghost') {
    const ghostExport = readGhostExport(targetDir);
    if (ghostExport) {
      if (ghostExport.settings.url) siteUrl = ghostExport.settings.url.replace(/\/$/, '');
      siteTitle = ghostExport.settings.title;
      siteDescription = ghostExport.settings.description;
    }
  }

  const integrations: string[] = [];
  const integrationImports: string[] = [];
  if (hasMdx) { integrationImports.push("import mdx from '@astrojs/mdx';"); integrations.push('mdx()'); }
  if (hasSitemap) { integrationImports.push("import sitemap from '@astrojs/sitemap';"); integrations.push('sitemap()'); }

  const config = `// @ts-check
import { defineConfig } from 'astro/config';
${integrationImports.join('\n')}

export default defineConfig({
  site: '${siteUrl}',
${siteTitle ? `  // Original site: ${siteTitle}` : ''}
${siteDescription ? `  // Description: ${siteDescription}` : ''}
  output: 'static',
  trailingSlash: 'always',
  compressHTML: true,
${integrations.length > 0 ? `  integrations: [${integrations.join(', ')}],` : ''}
});
`;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, config, 'utf-8');
}

// ── Asset localizer ─────────────────────────────────────────────────────

export interface AssetResult { total: number; unique: number; localized: number }

export function localizeAssets(manifest: Manifest, targetDir: string, strategy: 'assets' | 'public' | 'localize-external', dryRun: boolean): AssetResult {
  const seen = new Set<string>();
  let localized = 0;
  const assetsDir = resolve(targetDir, 'src/assets/blog');
  const publicDir = resolve(targetDir, 'public/images');

  if (!dryRun) { mkdirSync(assetsDir, { recursive: true }); mkdirSync(publicDir, { recursive: true }); }

  for (const image of manifest.extract.images) {
    const filename = basename(image.relativePath);
    const dedupeKey = filename.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!existsSync(image.absolutePath)) continue;

    if (!dryRun) {
      const destDir = (strategy === 'assets' || strategy === 'localize-external') ? assetsDir : publicDir;
      try { copyFileSync(image.absolutePath, resolve(destDir, filename)); localized++; } catch { /* skip */ }

      if (image.source === 'static') {
        const relFromStatic = image.relativePath.replace(/^static\//, '');
        const destPath = resolve(targetDir, 'public', relFromStatic);
        try { mkdirSync(dirname(destPath), { recursive: true }); copyFileSync(image.absolutePath, destPath); } catch { /* skip */ }
      }
    } else {
      localized++;
    }
  }

  return { total: manifest.extract.images.length, unique: seen.size, localized };
}

// ── Redirect writer ─────────────────────────────────────────────────────

export interface RedirectResult { count: number; clientOnly: number }

export function writeRedirects(manifest: Manifest, targetDir: string, format: 'netlify' | 'vercel' | 'astro', dryRun: boolean): RedirectResult {
  const redirects = generateRedirects(manifest);
  let clientOnly = 0;
  for (const plugin of manifest.extract.plugins) {
    if (plugin.gatsbyPlugin.includes('reach') || plugin.gatsbyPlugin.includes('router')) clientOnly++;
  }

  if (dryRun || redirects.length === 0) return { count: redirects.length, clientOnly };

  if (format === 'netlify') {
    const path = resolve(targetDir, 'public/_redirects');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, redirects.map((r) => `${r.from}\t${r.to}\t${r.status || 301}`).join('\n') + '\n', 'utf-8');
  } else if (format === 'vercel') {
    writeFileSync(resolve(targetDir, 'vercel.json'), JSON.stringify({
      redirects: redirects.map((r) => ({ source: r.from, destination: r.to, permanent: (r.status || 301) === 301 })),
    }, null, 2) + '\n', 'utf-8');
  } else {
    const redirectObj: Record<string, string> = {};
    for (const r of redirects) redirectObj[r.from] = r.to;
    if (Object.keys(redirectObj).length > 0 && !existsSync(resolve(targetDir, 'astro.config.mjs'))) {
      mkdirSync(resolve(targetDir, 'src'), { recursive: true });
      writeFileSync(resolve(targetDir, 'astro.config.mjs'), `// @ts-check\nimport { defineConfig } from 'astro/config';\nimport sitemap from '@astrojs/sitemap';\n\nexport default defineConfig({\n  site: 'https://example.com',\n  output: 'static',\n  trailingSlash: 'always',\n  compressHTML: true,\n  integrations: [sitemap()],\n  redirects: ${JSON.stringify(redirectObj, null, 4)},\n});\n`, 'utf-8');
    }
  }

  return { count: redirects.length, clientOnly };
}

function generateRedirects(_manifest: Manifest): Array<{ from: string; to: string; status?: number }> {
  // Redirect generation from createPages analysis — placeholder for now
  return [];
}
