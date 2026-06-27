import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { parseWxr } from '../src/wxr-parser.js';
import {
  htmlToPortableText,
  mapWxrItemToSanity,
  mapWxrTagToSanity,
  mapWxrCategoryToSanity,
  mapWxrAuthorToSanity,
  generateSanitySchema,
  generateNdjson,
  writeSanityOutput,
  WXR_SANITY_FIELD_MAP,
  mapSquarespaceFeaturesToSanity,
} from '../src/sanity-writer.js';
import type { WxrItem, WxrTag, WxrCategory } from '../src/wxr-parser.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const SQSP_FIXTURES = resolve(FIXTURES, 'squarespace-export');
const SQSP_XML_PATH = resolve(SQSP_FIXTURES, 'squarespace-export.xml');

// ── HTML → Portable Text ─────────────────────────────────────────────────

describe('htmlToPortableText', () => {
  it('converts a simple paragraph', () => {
    const blocks = htmlToPortableText('<p>Hello world</p>');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const block = blocks[0] as Record<string, unknown>;
    expect(block._type).toBe('block');
    expect(block.style).toBe('normal');
  });

  it('converts headings', () => {
    const blocks = htmlToPortableText('<h2>Section Title</h2>');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const block = blocks[0] as Record<string, unknown>;
    expect(block.style).toBe('h2');
  });

  it('converts blockquotes', () => {
    const blocks = htmlToPortableText('<blockquote>Quote text</blockquote>');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const block = blocks[0] as Record<string, unknown>;
    expect(block.style).toBe('blockquote');
  });

  it('handles empty input', () => {
    expect(htmlToPortableText('')).toEqual([]);
    expect(htmlToPortableText('   ')).toEqual([]);
  });

  it('handles plain text without HTML tags', () => {
    const blocks = htmlToPortableText('Just text');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('strips Squarespace sqs-block wrappers', () => {
    const html = '<div class="sqs-block sqs-block-html"><p>Clean content</p></div>';
    const blocks = htmlToPortableText(html);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('handles unordered lists', () => {
    const html = '<ul><li>Item one</li><li>Item two</li></ul>';
    const blocks = htmlToPortableText(html);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const first = blocks[0] as Record<string, unknown>;
    expect(first.listItem).toBe('bullet');
  });

  it('handles ordered lists', () => {
    const html = '<ol><li>Step one</li><li>Step two</li></ol>';
    const blocks = htmlToPortableText(html);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const first = blocks[0] as Record<string, unknown>;
    expect(first.listItem).toBe('number');
  });

  it('handles code blocks', () => {
    const blocks = htmlToPortableText('<pre>const x = 1;</pre>');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const block = blocks[0] as Record<string, unknown>;
    expect(block._type).toBe('code');
  });

  it('extracts Squarespace CDN images as image blocks', () => {
    const html = '<img src="https://images.squarespace-cdn.com/content/v1/abc123/photo.jpg?format=750w" alt="A photo" />';
    const blocks = htmlToPortableText(html);
    const imgBlock = blocks.find((b: Record<string, unknown>) => b._type === 'image');
    expect(imgBlock).toBeDefined();
    const img = imgBlock as Record<string, unknown>;
    expect(img._sanityAsset).toContain('assets/photo.jpg');
  });
});

// ── WXR Item → Sanity Document ───────────────────────────────────────────

describe('mapWxrItemToSanity', () => {
  const item: WxrItem = {
    title: 'My First Blog Post',
    postName: 'my-first-blog-post',
    postType: 'post',
    content: '<p>Welcome to my first blog post.</p>',
    excerpt: 'A brief summary',
    pubDate: 'Mon, 15 Jan 2024 10:00:00 +0000',
    postDate: '2024-01-15 10:00:00',
    postDateGmt: '2024-01-15 10:00:00',
    status: 'publish',
    tags: ['javascript', 'webdev'],
    categories: ['Technology'],
    creator: 'Alice Chen',
    link: 'https://mysite.squarespace.com/blog/my-first-blog-post',
    postId: 1,
    postParent: 0,
    attachmentUrl: '',
    postPassword: '',
    isSticky: false,
    postMeta: [],
    comments: [],
  };

  const emptyMaps: Record<string, string> = {};

  it('maps basic fields', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.title).toBe('My First Blog Post');
    expect(doc._type).toBe('post');
  });

  it('creates a slug', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    const slug = doc.slug as Record<string, unknown>;
    expect(slug._type).toBe('slug');
    expect(slug.current).toBe('my-first-blog-post');
  });

  it('converts content to Portable Text', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(Array.isArray(doc.body)).toBe(true);
    expect((doc.body as unknown[]).length).toBeGreaterThan(0);
  });

  it('maps excerpt', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.excerpt).toBe('A brief summary');
  });

  it('maps published date', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.publishedAt).toBeTruthy();
  });

  it('maps status to _status', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc._status).toBe('published');
  });

  it('maps draft status', () => {
    const draftItem = { ...item, status: 'draft' as const };
    const doc = mapWxrItemToSanity(draftItem, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc._status).toBe('draft');
  });

  it('maps tags as mixed references and strings', () => {
    const tagMap = { 'javascript': 'tag_js' };
    const doc = mapWxrItemToSanity(item, {}, tagMap, emptyMaps, emptyMaps, emptyMaps);
    const tags = doc.tags as unknown[];
    expect(tags.length).toBe(2);
    const jsTag = tags[0] as Record<string, unknown>;
    expect(jsTag._type).toBe('reference');
    expect(jsTag._ref).toBe('tag_js');
    const webdevTag = tags[1] as string;
    expect(webdevTag).toBe('webdev');
  });

  it('maps categories as references', () => {
    const catMap = { 'Technology': 'category_tech' };
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, catMap, emptyMaps, emptyMaps);
    const cats = doc.categories as unknown[];
    expect(cats.length).toBe(1);
    const cat = cats[0] as Record<string, unknown>;
    expect(cat._ref).toBe('category_tech');
  });

  it('maps author as reference', () => {
    const authorMap = { 'Alice Chen': 'author_alice' };
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, authorMap, emptyMaps);
    const authors = doc.authors as unknown[];
    expect(authors.length).toBe(1);
    const author = authors[0] as Record<string, unknown>;
    expect(author._ref).toBe('author_alice');
    expect(author._weak).toBe(true);
  });

  it('maps original URL', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.originalUrl).toContain('mysite.squarespace.com');
  });

  it('uses prefix ID strategy by default', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc._id).toContain('post_');
  });

  it('uses original ID strategy when specified', () => {
    const doc = mapWxrItemToSanity(item, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps, 'original');
    expect(doc._id).toBe(String(item.postId));
  });

  it('maps page type correctly', () => {
    const pageItem = { ...item, postType: 'page' as const };
    const doc = mapWxrItemToSanity(pageItem, {}, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(doc._type).toBe('page');
  });

  it('registers ID in idMap', () => {
    const idMap: Record<string, string> = {};
    mapWxrItemToSanity(item, idMap, emptyMaps, emptyMaps, emptyMaps, emptyMaps);
    expect(idMap['item_1']).toBeTruthy();
  });
});

// ── Tag → Sanity Document ──────────────────────────────────────────────

describe('mapWxrTagToSanity', () => {
  it('creates a tag document', () => {
    const idMap: Record<string, string> = {};
    const doc = mapWxrTagToSanity({ name: 'javascript', slug: 'javascript' }, idMap);
    expect(doc._type).toBe('tag');
    expect(doc.name).toBe('javascript');
    expect((doc.slug as Record<string, unknown>).current).toBe('javascript');
    expect(idMap['tag_javascript']).toBeTruthy();
  });

  it('derives slug from name when slug is missing', () => {
    const doc = mapWxrTagToSanity({ name: 'Web Development' }, {});
    expect((doc.slug as Record<string, unknown>).current).toBe('web-development');
  });
});

// ── Category → Sanity Document ──────────────────────────────────────────

describe('mapWxrCategoryToSanity', () => {
  it('creates a category document', () => {
    const idMap: Record<string, string> = {};
    const doc = mapWxrCategoryToSanity({ name: 'Technology', slug: 'technology' }, idMap);
    expect(doc._type).toBe('category');
    expect(doc.name).toBe('Technology');
    expect(idMap['category_Technology']).toBeTruthy();
  });
});

// ── Author → Sanity Document ────────────────────────────────────────────

describe('mapWxrAuthorToSanity', () => {
  it('creates an author document', () => {
    const idMap: Record<string, string> = {};
    const doc = mapWxrAuthorToSanity(
      { login: 'alice', displayName: 'Alice Chen', email: 'alice@example.com' },
      idMap,
    );
    expect(doc._type).toBe('author');
    expect(doc.name).toBe('Alice Chen');
    expect((doc.slug as Record<string, unknown>).current).toBe('alice');
    expect(doc.email).toBe('alice@example.com');
    expect(idMap['author_alice']).toBeTruthy();
  });

  it('derives slug from displayName when login is missing', () => {
    const doc = mapWxrAuthorToSanity({ login: '', displayName: 'Bob Martinez' }, {});
    expect((doc.slug as Record<string, unknown>).current).toBe('bob-martinez');
  });
});

// ── Sanity Schema Generation ────────────────────────────────────────────

describe('generateSanitySchema', () => {
  it('generates valid TypeScript with all schema types', () => {
    const schema = generateSanitySchema();
    expect(schema).toContain("defineType");
    expect(schema).toContain("name: 'post'");
    expect(schema).toContain("name: 'page'");
    expect(schema).toContain("name: 'tag'");
    expect(schema).toContain("name: 'category'");
    expect(schema).toContain("name: 'author'");
  });

  it('includes Portable Text body field for posts', () => {
    const schema = generateSanitySchema();
    expect(schema).toContain("name: 'body'");
    expect(schema).toContain("type: 'array'");
    expect(schema).toContain("type: 'block'");
  });

  it('includes slug fields', () => {
    const schema = generateSanitySchema();
    expect(schema).toContain("type: 'slug'");
  });

  it('includes reference fields for tags and authors', () => {
    const schema = generateSanitySchema();
    expect(schema).toContain("type: 'reference'");
    expect(schema).toContain("to: [{ type: 'tag' }]");
    expect(schema).toContain("to: [{ type: 'author' }]");
  });
});

// ── NDJSON Generation ──────────────────────────────────────────────────

describe('generateNdjson', () => {
  const xmlContent = readFileSync(SQSP_XML_PATH, 'utf-8');
  const wxrResult = parseWxr(xmlContent);

  it('generates documents from the fixture WXR', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    expect(result.documents.length).toBeGreaterThan(0);
  });

  it('orders taxonomy documents before posts', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    const types = result.documents.map((d) => d._type);
    const firstPostIdx = types.indexOf('post');
    const firstTagIdx = types.indexOf('tag');
    const firstCatIdx = types.indexOf('category');
    // Tags and categories should come before posts (if they exist)
    if (firstTagIdx !== -1 && firstPostIdx !== -1) {
      expect(firstTagIdx).toBeLessThan(firstPostIdx);
    }
    if (firstCatIdx !== -1 && firstPostIdx !== -1) {
      expect(firstCatIdx).toBeLessThan(firstPostIdx);
    }
  });

  it('creates authors from dc:creator values', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    const authorDocs = result.documents.filter((d) => d._type === 'author');
    expect(authorDocs.length).toBeGreaterThan(0);
  });

  it('builds a complete ID map', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    // Every document should have an entry in the idMap
    expect(Object.keys(result.idMap).length).toBeGreaterThan(0);
  });

  it('lists schema types used', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    expect(result.schemaTypes).toContain('post');
    expect(result.schemaTypes).toContain('page');
    expect(result.schemaTypes).toContain('tag');
    expect(result.schemaTypes).toContain('category');
    expect(result.schemaTypes).toContain('author');
  });

  it('extracts Squarespace CDN image assets', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    expect(result.assetPaths.length).toBeGreaterThan(0);
    // Should contain .jpg filenames from the fixture
    expect(result.assetPaths.some((p) => p.endsWith('.jpg'))).toBe(true);
  });

  it('resolves tag references in posts', () => {
    const result = generateNdjson(
      wxrResult.items,
      wxrResult.tags,
      wxrResult.categories,
      wxrResult.channelInfo.authors,
      wxrResult.channelInfo,
    );
    const posts = result.documents.filter((d) => d._type === 'post');
    const postWithTags = posts.find((p) => Array.isArray(p.tags) && p.tags.length > 0);
    if (postWithTags) {
      const tagRefs = (postWithTags.tags as unknown[]).filter(
        (t: Record<string, unknown>) => t._type === 'reference',
      );
      expect(tagRefs.length).toBeGreaterThan(0);
    }
  });
});

// ── File Output ────────────────────────────────────────────────────────

describe('writeSanityOutput', () => {
  const tmpDir = resolve(__dirname, 'fixtures', 'sanity-tmp-test');

  it('writes NDJSON, schema, id-map, and assets directory', () => {
    mkdirSync(tmpDir, { recursive: true });

    // Copy the sidecar WXR items file
    const wxrItems = parseWxr(readFileSync(SQSP_XML_PATH, 'utf-8')).items;
    writeFileSync(resolve(tmpDir, 'portage-wxr-items.json'), JSON.stringify(wxrItems) + '\n', 'utf-8');

    // Create a minimal manifest
    const manifest = {
      version: '1' as const,
      source: { platform: 'squarespace' as const, path: SQSP_XML_PATH },
      extract: {
        contentFiles: [],
        images: [],
        plugins: [],
        queries: [],
        counts: { posts: 3, pages: 1, tags: 5, authors: 2, images: 3, plugins: 3, queries: 0 },
      },
    };

    const result = writeSanityOutput(manifest, tmpDir, false);

    expect(result.documentsWritten).toBeGreaterThan(0);
    expect(result.outputPath).toContain('data.ndjson');
    expect(existsSync(resolve(tmpDir, 'import/data.ndjson'))).toBe(true);
    expect(existsSync(resolve(tmpDir, 'sanity-schema.ts'))).toBe(true);
    expect(existsSync(resolve(tmpDir, 'id-map.json'))).toBe(true);
    expect(existsSync(resolve(tmpDir, 'import/assets'))).toBe(true);
    expect(existsSync(resolve(tmpDir, '.env'))).toBe(true);

    // Verify NDJSON is valid (each line is valid JSON)
    const ndjson = readFileSync(resolve(tmpDir, 'import/data.ndjson'), 'utf-8');
    const lines = ndjson.trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed._id).toBeTruthy();
      expect(parsed._type).toBeTruthy();
    }

    // Verify id-map.json
    const idMap = JSON.parse(readFileSync(resolve(tmpDir, 'id-map.json'), 'utf-8'));
    expect(Object.keys(idMap).length).toBeGreaterThan(0);

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns counts in dry-run mode without writing', () => {
    mkdirSync(tmpDir, { recursive: true });
    const wxrItems = parseWxr(readFileSync(SQSP_XML_PATH, 'utf-8')).items;
    writeFileSync(resolve(tmpDir, 'portage-wxr-items.json'), JSON.stringify(wxrItems) + '\n', 'utf-8');

    const manifest = {
      version: '1' as const,
      source: { platform: 'squarespace' as const, path: SQSP_XML_PATH },
      extract: {
        contentFiles: [],
        images: [],
        plugins: [],
        queries: [],
        counts: { posts: 3, pages: 1, tags: 5, authors: 2, images: 3, plugins: 3, queries: 0 },
      },
    };

    const result = writeSanityOutput(manifest, tmpDir, true);
    expect(result.documentsWritten).toBeGreaterThan(0);
    expect(result.outputPath).toBe('');
    expect(existsSync(resolve(tmpDir, 'import'))).toBe(false);

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Field Map ──────────────────────────────────────────────────────────

describe('WXR_SANITY_FIELD_MAP', () => {
  it('maps core WXR fields to Sanity fields', () => {
    expect(WXR_SANITY_FIELD_MAP.title).toBe('title');
    expect(WXR_SANITY_FIELD_MAP.postName).toBe('slug');
    expect(WXR_SANITY_FIELD_MAP.content).toBe('body');
    expect(WXR_SANITY_FIELD_MAP.excerpt).toBe('excerpt');
    expect(WXR_SANITY_FIELD_MAP.pubDate).toBe('publishedAt');
    expect(WXR_SANITY_FIELD_MAP.tags).toBe('tags');
    expect(WXR_SANITY_FIELD_MAP.categories).toBe('categories');
    expect(WXR_SANITY_FIELD_MAP.creator).toBe('authors');
  });

  it('maps status to _status (not draft)', () => {
    expect(WXR_SANITY_FIELD_MAP.status).toBe('_status');
  });
});

// ── Feature Mapping ────────────────────────────────────────────────────

describe('mapSquarespaceFeaturesToSanity', () => {
  it('maps blog feature to post schema type', () => {
    const plugins = [{ gatsbyPlugin: 'blog' }];
    const result = mapSquarespaceFeaturesToSanity(plugins);
    expect(result.mapped).toBe(1);
    expect(result.unmapped.length).toBe(0);
  });

  it('flags unmapped features', () => {
    const plugins = [
      { gatsbyPlugin: 'sitemap' },
      { gatsbyPlugin: 'form-block' },
      { gatsbyPlugin: 'store-page' },
    ];
    const result = mapSquarespaceFeaturesToSanity(plugins);
    expect(result.unmapped).toContain('sitemap');
    expect(result.unmapped).toContain('form-block');
    expect(result.unmapped).toContain('store-page');
  });

  it('maps gallery-block to image array field', () => {
    const plugins = [{ gatsbyPlugin: 'gallery-block' }];
    const result = mapSquarespaceFeaturesToSanity(plugins);
    expect(result.mapped).toBe(1);
  });
});
