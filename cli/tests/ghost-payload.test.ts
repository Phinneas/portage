import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  parseGhostExport,
  resolveGhostUrl,
  extractGhostImages,
  mapGhostFeaturesToAstro,
  GHOST_PAYLOAD_FIELD_MAP,
  GHOST_ASTRO_FIELD_MAP,
  writeGhostExport,
  readGhostExport,
} from '../src/ghost.js';
import {
  mapGhostPostToPayload,
  mapGhostTagToPayload,
  mapGhostAuthorToPayload,
  generatePayloadConfig,
  generateSeedScript,
} from '../src/payload-writer.js';
import type { GhostExport } from '../src/ghost.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const GHOST_FIXTURES = resolve(FIXTURES, 'ghost-export');
const GHOST_JSON_PATH = resolve(GHOST_FIXTURES, 'ghost-export.json');

// ── Ghost JSON Parser ────────────────────────────────────────────────────

describe('parseGhostExport', () => {
  const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');

  it('parses post titles', () => {
    expect(ghostExport.posts.length).toBe(4);
    expect(ghostExport.posts[0].title).toBe('Leaving the Walled Garden');
  });

  it('parses post slugs', () => {
    expect(ghostExport.posts[0].slug).toBe('leaving-the-walled-garden');
    expect(ghostExport.posts[1].slug).toBe('harbor-notes');
  });

  it('parses custom excerpts', () => {
    expect(ghostExport.posts[0].customExcerpt).toBe('Why we moved our publication off a hosted platform.');
  });

  it('parses post types (post vs page)', () => {
    expect(ghostExport.posts[0].type).toBe('post');
    expect(ghostExport.posts[3].type).toBe('page');
  });

  it('parses post status', () => {
    expect(ghostExport.posts[0].status).toBe('published');
    expect(ghostExport.posts[2].status).toBe('draft');
  });

  it('parses visibility', () => {
    expect(ghostExport.posts[0].visibility).toBe('public');
    expect(ghostExport.posts[1].visibility).toBe('members');
  });

  it('parses feature images', () => {
    expect(ghostExport.posts[0].featureImage).toContain('walled-garden.jpg');
  });

  it('parses feature image alt text', () => {
    expect(ghostExport.posts[0].featureImageAlt).toBe('A weathered lock gate at low tide');
  });

  it('parses lexical content', () => {
    expect(ghostExport.posts[0].lexical).toContain('lexical');
  });

  it('parses HTML content', () => {
    expect(ghostExport.posts[0].html).toContain('<p>');
  });

  it('resolves tag IDs from join table', () => {
    const post1 = ghostExport.posts[0];
    expect(post1.tagIds).toEqual(['1', '2']);
  });

  it('resolves author IDs from join table', () => {
    const post1 = ghostExport.posts[0];
    expect(post1.authorIds).toEqual(['1']);
  });

  it('parses tags', () => {
    expect(ghostExport.tags.length).toBe(3);
    expect(ghostExport.tags[0].name).toBe('migration');
  });

  it('identifies internal tags', () => {
    const internal = ghostExport.tags.find((t) => t.isInternal);
    expect(internal?.name).toBe('#internal-newsletter');
  });

  it('parses authors', () => {
    expect(ghostExport.authors.length).toBe(2);
    expect(ghostExport.authors[0].name).toBe('Dana Reyes');
    expect(ghostExport.authors[0].slug).toBe('dana');
  });

  it('parses author profile images', () => {
    expect(ghostExport.authors[0].profileImage).toContain('dana.jpg');
  });

  it('parses featured flag', () => {
    expect(ghostExport.posts[0].featured).toBe(true);
    expect(ghostExport.posts[1].featured).toBe(false);
  });

  it('parses canonical URL', () => {
    expect(ghostExport.posts[1].canonicalUrl).toBe('https://blog.example.com/harbor-notes/');
  });

  it('parses SEO metadata', () => {
    const page = ghostExport.posts[3]; // About Us page has meta_title
    expect(page.metaTitle).toBe('About Us - My Ghost Publication');
    expect(page.metaDescription).toBe('Learn about our publication.');
  });

  it('parses meta info', () => {
    expect(ghostExport.meta.title).toBe('My Ghost Publication');
    expect(ghostExport.meta.url).toBe('https://blog.example.com');
  });
});

// ── Ghost URL Resolution ─────────────────────────────────────────────────

describe('resolveGhostUrl', () => {
  it('replaces __GHOST_URL__ placeholder', () => {
    const url = resolveGhostUrl('__GHOST_URL__/content/images/2025/test.jpg', 'https://blog.example.com');
    expect(url).toBe('https://blog.example.com/content/images/2025/test.jpg');
  });

  it('strips size variants', () => {
    const url = resolveGhostUrl('https://blog.example.com/content/images/size/w600/2025/test.jpg', 'https://blog.example.com');
    expect(url).not.toContain('/size/');
  });

  it('returns empty for empty input', () => {
    expect(resolveGhostUrl('', 'https://blog.example.com')).toBe('');
  });
});

// ── Image Extraction ──────────────────────────────────────────────────────

describe('extractGhostImages', () => {
  const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');
  const images = extractGhostImages(ghostExport);

  it('extracts feature images from posts', () => {
    expect(images.length).toBeGreaterThanOrEqual(2); // walled-garden + harbor-dawn
  });

  it('extracts inline images from HTML', () => {
    const inlineImg = images.find((i) => i.absolutePath.includes('walled-garden.jpg'));
    expect(inlineImg).toBeDefined();
  });

  it('extracts author profile images', () => {
    const authorImg = images.find((i) => i.absolutePath.includes('dana.jpg'));
    expect(authorImg).toBeDefined();
  });

  it('marks images as remote source', () => {
    for (const img of images) {
      expect(img.source).toBe('remote');
    }
  });

  it('deduplicates images', () => {
    // If feature_image is also in the HTML, it should be deduped
    const urls = images.map((i) => i.absolutePath);
    const unique = new Set(urls);
    expect(urls.length).toBe(unique.size);
  });
});

// ── Feature Mapping ──────────────────────────────────────────────────────

describe('mapGhostFeaturesToAstro', () => {
  it('flags all Ghost platform features as unmapped', () => {
    const plugins = [
      { gatsbyPlugin: 'members', astroEquivalent: undefined, options: undefined, needsReview: false },
      { gatsbyPlugin: 'subscriptions', astroEquivalent: undefined, options: undefined, needsReview: false },
    ];
    const result = mapGhostFeaturesToAstro(plugins);
    expect(result.unmapped.length).toBe(2);
    expect(plugins[0].needsReview).toBe(true);
  });
});

// ── Field Maps ──────────────────────────────────────────────────────────

describe('GHOST_PAYLOAD_FIELD_MAP', () => {
  it('maps core Ghost fields to Payload fields', () => {
    expect(GHOST_PAYLOAD_FIELD_MAP.title).toBe('title');
    expect(GHOST_PAYLOAD_FIELD_MAP.slug).toBe('slug');
    expect(GHOST_PAYLOAD_FIELD_MAP.customExcerpt).toBe('excerpt');
    expect(GHOST_PAYLOAD_FIELD_MAP.lexical).toBe('content');
    expect(GHOST_PAYLOAD_FIELD_MAP.html).toBe('htmlContent');
    expect(GHOST_PAYLOAD_FIELD_MAP.featureImage).toBe('featureImage');
    expect(GHOST_PAYLOAD_FIELD_MAP.publishedAt).toBe('publishedAt');
    expect(GHOST_PAYLOAD_FIELD_MAP.tagIds).toBe('tags');
    expect(GHOST_PAYLOAD_FIELD_MAP.authorIds).toBe('authors');
    expect(GHOST_PAYLOAD_FIELD_MAP.visibility).toBe('visibility');
    expect(GHOST_PAYLOAD_FIELD_MAP.status).toBe('_status');
    expect(GHOST_PAYLOAD_FIELD_MAP.canonicalUrl).toBe('canonicalUrl');
    expect(GHOST_PAYLOAD_FIELD_MAP.featured).toBe('featured');
  });

  it('maps SEO fields to nested group paths', () => {
    expect(GHOST_PAYLOAD_FIELD_MAP.metaTitle).toBe('seo.title');
    expect(GHOST_PAYLOAD_FIELD_MAP.metaDescription).toBe('seo.description');
    expect(GHOST_PAYLOAD_FIELD_MAP.ogImage).toBe('seo.openGraph.image');
    expect(GHOST_PAYLOAD_FIELD_MAP.twitterTitle).toBe('seo.twitter.title');
  });
});

describe('GHOST_ASTRO_FIELD_MAP', () => {
  it('maps core Ghost fields to Astro frontmatter', () => {
    expect(GHOST_ASTRO_FIELD_MAP.title).toBe('title');
    expect(GHOST_ASTRO_FIELD_MAP.publishedAt).toBe('pubDate');
    expect(GHOST_ASTRO_FIELD_MAP.featureImage).toBe('heroImage');
    expect(GHOST_ASTRO_FIELD_MAP.visibility).toBe('access');
    expect(GHOST_ASTRO_FIELD_MAP.status).toBe('draft');
  });
});

// ── Ghost → Payload Post Mapping ─────────────────────────────────────────

describe('mapGhostPostToPayload', () => {
  const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');
  const post = ghostExport.posts[0]; // "Leaving the Walled Garden"
  const emptyMaps: Record<string, string> = {};

  it('maps basic fields', () => {
    const doc = mapGhostPostToPayload(post, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.title).toBe('Leaving the Walled Garden');
    expect(doc.slug).toBe('leaving-the-walled-garden');
    expect(doc.excerpt).toBe('Why we moved our publication off a hosted platform.');
  });

  it('maps Lexical content as parsed JSON', () => {
    const doc = mapGhostPostToPayload(post, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.content).toBeDefined();
    expect(typeof doc.content).toBe('object');
  });

  it('stores HTML as htmlContent fallback', () => {
    const doc = mapGhostPostToPayload(post, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.htmlContent).toContain('<p>');
  });

  it('maps visibility to access levels', () => {
    const publicPost = mapGhostPostToPayload(ghostExport.posts[0], emptyMaps, emptyMaps, emptyMaps);
    expect(publicPost.visibility).toBe('public');

    const membersPost = mapGhostPostToPayload(ghostExport.posts[1], emptyMaps, emptyMaps, emptyMaps);
    expect(membersPost.visibility).toBe('members');
  });

  it('maps draft status', () => {
    const draftPost = mapGhostPostToPayload(ghostExport.posts[2], emptyMaps, emptyMaps, emptyMaps);
    expect(draftPost._status).toBe('draft');
  });

  it('maps published status', () => {
    const publishedPost = mapGhostPostToPayload(ghostExport.posts[0], emptyMaps, emptyMaps, emptyMaps);
    expect(publishedPost._status).toBe('published');
  });

  it('maps featured flag', () => {
    const doc = mapGhostPostToPayload(post, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.featured).toBe(true);
  });

  it('resolves tag relationships with ID map', () => {
    const tagMap = { '1': 'tag-doc-1', '2': 'tag-doc-2' };
    const doc = mapGhostPostToPayload(post, tagMap, emptyMaps, emptyMaps);
    expect(doc.tags).toEqual(['tag-doc-1', 'tag-doc-2']);
  });

  it('resolves author relationships with ID map', () => {
    const authorMap = { '1': 'author-doc-1' };
    const doc = mapGhostPostToPayload(post, emptyMaps, authorMap, emptyMaps);
    expect(doc.authors).toEqual(['author-doc-1']);
  });

  it('maps feature image to media relationship', () => {
    const mediaMap = { [post.featureImage]: 'media-doc-1' };
    const doc = mapGhostPostToPayload(post, emptyMaps, emptyMaps, mediaMap);
    expect(doc.featureImage).toBe('media-doc-1');
  });

  it('maps SEO metadata to group field', () => {
    const doc = mapGhostPostToPayload(ghostExport.posts[3], emptyMaps, emptyMaps, emptyMaps); // About Us has meta_title
    expect(doc.seo).toBeDefined();
    expect((doc.seo as Record<string, unknown>).title).toBe('About Us - My Ghost Publication');
  });

  it('maps code injection to ghost namespace', () => {
    const postWithCI = { ...post, codeinjectionHead: '<script>test</script>', codeinjectionFoot: '<style>test</style>' };
    const doc = mapGhostPostToPayload(postWithCI, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.ghost).toBeDefined();
    const ghost = (doc.ghost as Record<string, unknown>).codeInjection as Record<string, unknown>;
    expect(ghost.head).toBe('<script>test</script>');
    expect(ghost.foot).toBe('<style>test</style>');
  });

  it('strips HTML from feature image caption', () => {
    const postWithCaption = { ...post, featureImageCaption: '<em>Photo by the author</em>' };
    const doc = mapGhostPostToPayload(postWithCaption, emptyMaps, emptyMaps, emptyMaps);
    expect(doc.featureImageCaption).toBe('Photo by the author');
  });
});

// ── Ghost → Payload Tag Mapping ──────────────────────────────────────────

describe('mapGhostTagToPayload', () => {
  const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');
  const tag = ghostExport.tags[0];
  const emptyMedia: Record<string, string> = {};

  it('maps tag fields', () => {
    const doc = mapGhostTagToPayload(tag, emptyMedia);
    expect(doc.name).toBe('migration');
    expect(doc.slug).toBe('migration');
    expect(doc.description).toBe('Posts about platform migration');
  });
});

// ── Ghost → Payload Author Mapping ──────────────────────────────────────

describe('mapGhostAuthorToPayload', () => {
  const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');
  const author = ghostExport.authors[0];
  const emptyMedia: Record<string, string> = {};

  it('maps author fields', () => {
    const doc = mapGhostAuthorToPayload(author, emptyMedia);
    expect(doc.name).toBe('Dana Reyes');
    expect(doc.slug).toBe('dana');
    expect(doc.bio).toBe('Writer and editor. Covers platform migration.');
    expect(doc.website).toBe('https://danareyes.com');
    expect(doc.location).toBe('Seattle');
    expect(doc.facebook).toBe('dana.reyes');
    expect(doc.twitter).toBe('@danareyes');
  });
});

// ── Payload Config Generation ────────────────────────────────────────────

describe('generatePayloadConfig', () => {
  it('generates valid TypeScript config', () => {
    const config = generatePayloadConfig();
    expect(config).toContain("buildConfig");
    expect(config).toContain("slug: 'posts'");
    expect(config).toContain("slug: 'pages'");
    expect(config).toContain("slug: 'tags'");
    expect(config).toContain("slug: 'authors'");
    expect(config).toContain("slug: 'media'");
    expect(config).toContain("upload: true");
    expect(config).toContain("sqliteAdapter");
  });

  it('includes relationship fields', () => {
    const config = generatePayloadConfig();
    expect(config).toContain("relationTo: 'tags'");
    expect(config).toContain("relationTo: 'authors'");
    expect(config).toContain("relationTo: 'media'");
  });

  it('includes SEO group fields', () => {
    const config = generatePayloadConfig();
    expect(config).toContain("name: 'seo', type: 'group'");
    expect(config).toContain("name: 'openGraph', type: 'group'");
    expect(config).toContain("name: 'twitter', type: 'group'");
  });
});

// ── Seed Script Generation ────────────────────────────────────────────

describe('generateSeedScript', () => {
  const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');
  const script = generateSeedScript(ghostExport);

  it('imports Payload dependencies', () => {
    expect(script).toContain("import { getPayload } from 'payload'");
    expect(script).toContain("import config from '@payload-config'");
  });

  it('creates tags first', () => {
    const tagSection = script.indexOf('1. Create tags');
    expect(tagSection).toBeGreaterThan(-1);
    expect(script).toContain("collection: 'tags'");
  });

  it('creates media second', () => {
    expect(script).toContain('2. Create media');
    expect(script).toContain("collection: 'media'");
    expect(script).toContain('filePath');
  });

  it('creates authors third', () => {
    expect(script).toContain('3. Create authors');
    expect(script).toContain("collection: 'authors'");
  });

  it('creates posts/pages last', () => {
    expect(script).toContain('4. Create posts and pages');
    expect(script).toContain("collection: 'posts'");
  });

  it('skips internal tags in seed', () => {
    const internalTag = ghostExport.tags.find((t) => t.isInternal);
    expect(internalTag?.name).toBe('#internal-newsletter');
    // The seed script should not include internal tags
    expect(script).not.toContain('#internal-newsletter');
  });
});

// ── Sidecar Persistence ──────────────────────────────────────────────────

describe('writeGhostExport / readGhostExport', () => {
  const tmpDir = resolve(__dirname, 'fixtures', 'ghost-tmp-test');

  it('writes and reads ghost export sidecar', () => {
    const ghostExport = parseGhostExport(GHOST_JSON_PATH, 'https://blog.example.com');
    mkdirSync(tmpDir, { recursive: true });
    writeGhostExport(ghostExport, tmpDir);
    const read = readGhostExport(tmpDir);
    expect(read).toBeDefined();
    expect(read!.posts.length).toBe(4);
    expect(read!.tags.length).toBe(3);
    expect(read!.authors.length).toBe(2);

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no sidecar exists', () => {
    expect(readGhostExport('/nonexistent')).toBeNull();
  });
});
