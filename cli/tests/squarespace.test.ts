import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  parseWxr,
  type WxrItem,
} from '../src/wxr-parser.js';
import {
  convertHtmlToMarkdown,
  extractImages,
  deriveHero,
  mapSquarespaceFrontmatter,
  mapSquarespaceFeaturesToAstro,
  transformSquarespaceContent,
  deriveSlug,
  slugify,
  writeWxrItems,
  readWxrItems,
  SQUARESPACE_FIELD_KEY_MAP,
  extractSquarespace,
} from '../src/squarespace.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const WXR_PATH = resolve(FIXTURES, 'squarespace-export', 'squarespace-export.xml');

// ── WXR Parsing ─────────────────────────────────────────────────────────

describe('parseWxr', () => {
  const xml = readFileSync(WXR_PATH, 'utf-8');
  const result = parseWxr(xml);

  it('extracts channel info', () => {
    expect(result.channelInfo.title).toBe('My Squarespace Site');
    expect(result.channelInfo.link).toBe('https://mysite.squarespace.com');
    expect(result.channelInfo.description).toBe('A sample Squarespace export for testing');
  });

  it('filters to post and page types only', () => {
    expect(result.items.length).toBe(4); // 3 posts + 1 page (attachment excluded)
    expect(result.items.every(i => i.postType === 'post' || i.postType === 'page')).toBe(true);
  });

  it('parses first blog post correctly', () => {
    const post = result.items.find(i => i.postName === 'my-first-blog-post')!;
    expect(post.title).toBe('My First Blog Post');
    expect(post.creator).toBe('Alice Chen');
    expect(post.postType).toBe('post');
    expect(post.status).toBe('publish');
    expect(post.tags).toEqual(['javascript', 'webdev']);
    expect(post.categories).toEqual(['Technology']);
    expect(post.pubDate).toBe('Mon, 15 Jan 2024 10:00:00 +0000');
  });

  it('parses tags from category domain="post_tag"', () => {
    const post = result.items.find(i => i.postName === 'design-portfolio-update')!;
    expect(post.tags).toEqual(['portfolio', 'gallery']);
    expect(post.categories).toEqual(['Design']);
  });

  it('parses draft status', () => {
    const draft = result.items.find(i => i.postName === 'work-in-progress')!;
    expect(draft.status).toBe('draft');
  });

  it('parses page post type', () => {
    const page = result.items.find(i => i.postName === 'about-us')!;
    expect(page.postType).toBe('page');
    expect(page.title).toBe('About Us');
  });

  it('parses content:encoded with CDATA', () => {
    const post = result.items.find(i => i.postName === 'my-first-blog-post')!;
    expect(post.content).toContain('sqs-block');
    expect(post.content).toContain('Welcome to my first blog post');
  });

  it('parses excerpt:encoded', () => {
    const post = result.items.find(i => i.postName === 'my-first-blog-post')!;
    expect(post.excerpt).toContain('brief summary');
  });

  it('deduplicates tags and categories', () => {
    const post = result.items.find(i => i.postName === 'my-first-blog-post')!;
    expect(post.tags.length).toBe(new Set(post.tags).size);
  });

  it('parses channel-level metadata', () => {
    expect(result.channelInfo.title).toBe('My Squarespace Site');
    expect(result.channelInfo.link).toBe('https://mysite.squarespace.com');
  });

  it('includes post IDs', () => {
    for (const item of result.items) {
      expect(typeof item.postId).toBe('number');
    }
  });

  it('parses postDateGmt', () => {
    for (const item of result.items) {
      expect(item).toHaveProperty('postDateGmt');
    }
  });

  it('includes empty postMeta and comments arrays', () => {
    const post = result.items.find(i => i.postName === 'my-first-blog-post')!;
    expect(post.postMeta).toEqual([]);
    expect(post.comments).toEqual([]);
  });
});

// ── HTML to Markdown ─────────────────────────────────────────────────────

describe('convertHtmlToMarkdown', () => {
  it('strips sqs-block wrappers', () => {
    const html = '<div class="sqs-block sqs-block-html"><p>Hello world</p></div>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Hello world');
    expect(md).not.toContain('sqs-block');
  });

  it('converts headings', () => {
    const html = '<h2>Section Heading</h2>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('## Section Heading');
  });

  it('converts strong text', () => {
    const html = '<p>This is <strong>bold</strong> text</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('**bold**');
  });

  it('converts unordered lists', () => {
    const html = '<ul><li>Item one</li><li>Item two</li></ul>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Item one');
    expect(md).toMatch(/^-+\s*Item one/m);
    expect(md).toMatch(/^-+\s*Item two/m);
  });

  it('converts blockquotes', () => {
    const html = '<blockquote>This is a quote</blockquote>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('> This is a quote');
  });

  it('converts images to markdown', () => {
    const html = '<img src="https://images.squarespace-cdn.com/content/v1/test.jpg?format=750w" alt="Test" />';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('![Test]');
  });

  it('strips inline styles', () => {
    const html = '<p style="color: red;">Styled text</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Styled text');
    expect(md).not.toContain('color');
  });

  it('passes through plain text unchanged', () => {
    expect(convertHtmlToMarkdown('Hello world')).toBe('Hello world');
  });

  it('handles empty string', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
  });
});

// ── Image Extraction ─────────────────────────────────────────────────────

describe('extractImages', () => {
  const xml = readFileSync(WXR_PATH, 'utf-8');
  const images = extractImages(xml);

  it('finds all CDN images', () => {
    expect(images.length).toBeGreaterThanOrEqual(3);
  });

  it('strips format query parameters', () => {
    for (const img of images) {
      expect(img.relativePath).not.toContain('format=');
    }
  });

  it('marks images as remote source', () => {
    for (const img of images) {
      expect(img.source).toBe('remote');
    }
  });

  it('deduplicates images', () => {
    const paths = images.map(i => i.relativePath);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it('extracts filenames correctly', () => {
    const filenames = images.map(i => i.relativePath);
    expect(filenames).toContain('1705312000000-hero.jpg');
    expect(filenames).toContain('1705312000001-photo1.jpg');
    expect(filenames).toContain('1705312000002-photo2.jpg');
  });
});

// ── Hero Derivation ─────────────────────────────────────────────────────

describe('deriveHero', () => {
  it('returns first image URL from HTML', () => {
    const html = '<p>Text</p><img src="https://images.squarespace-cdn.com/content/v1/abc/hero.jpg?format=750w" />';
    const hero = deriveHero(html);
    expect(hero).toBe('https://images.squarespace-cdn.com/content/v1/abc/hero.jpg');
  });

  it('returns null for content with no images', () => {
    const html = '<p>Just text</p>';
    expect(deriveHero(html)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(deriveHero('')).toBeNull();
  });

  it('strips format query param', () => {
    const html = '<img src="https://images.squarespace-cdn.com/content/v1/test/img.png?format=1000w" />';
    const hero = deriveHero(html);
    expect(hero).not.toContain('format=');
  });
});

// ── Slug Derivation ─────────────────────────────────────────────────────

describe('deriveSlug', () => {
  it('uses postName when available', () => {
    const item: WxrItem = {
      title: 'My First Post',
      postName: 'my-first-post',
      postType: 'post',
      content: '',
      excerpt: '',
      pubDate: '',
      postDate: '',
      postDateGmt: '',
      status: 'publish',
      tags: [],
      categories: [],
      creator: '',
      link: '',
      postId: 0,
      postParent: 0,
      attachmentUrl: '',
      postPassword: '',
      isSticky: false,
      postMeta: [],
      comments: [],
    };
    expect(deriveSlug(item)).toBe('my-first-post');
  });

  it('slugifies title when postName is empty', () => {
    const item: WxrItem = {
      title: 'Hello World!',
      postName: '',
      postType: 'post',
      content: '',
      excerpt: '',
      pubDate: '',
      postDate: '',
      postDateGmt: '',
      status: 'publish',
      tags: [],
      categories: [],
      creator: '',
      link: '',
      postId: 0,
      postParent: 0,
      attachmentUrl: '',
      postPassword: '',
      isSticky: false,
      postMeta: [],
      comments: [],
    };
    expect(deriveSlug(item)).toBe('hello-world');
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('removes leading/trailing hyphens', () => {
    expect(slugify('--test--')).toBe('test');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

// ── Frontmatter Mapping ──────────────────────────────────────────────────

describe('mapSquarespaceFrontmatter', () => {
  const baseItem: WxrItem = {
    title: 'Test Post',
    postName: 'test-post',
    postType: 'post',
    content: '<img src="https://images.squarespace-cdn.com/content/v1/abc/hero.jpg?format=750w" />',
    excerpt: '<p>A brief summary</p>',
    pubDate: 'Mon, 15 Jan 2024 10:00:00 +0000',
    postDate: '2024-01-15 10:00:00',
    postDateGmt: '',
    status: 'publish',
    tags: ['javascript', 'webdev'],
    categories: ['Technology'],
    creator: 'Alice Chen',
    link: 'https://mysite.squarespace.com/blog/test-post',
    postId: 1,
    postParent: 0,
    attachmentUrl: '',
    postPassword: '',
    isSticky: false,
    postMeta: [],
    comments: [],
  };

  it('maps title', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.title).toBe('Test Post');
  });

  it('maps description from HTML excerpt', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.description).toBe('A brief summary');
  });

  it('maps pubDate', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.pubDate).toBeDefined();
  });

  it('maps tags', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.tags).toEqual(['javascript', 'webdev']);
  });

  it('maps categories', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.categories).toEqual(['Technology']);
  });

  it('maps creator as authors array', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.authors).toEqual(['Alice Chen']);
  });

  it('maps draft status', () => {
    const draftItem = { ...baseItem, status: 'draft' as const };
    const fm = mapSquarespaceFrontmatter(draftItem, 'first-image');
    expect(fm.draft).toBe(true);
  });

  it('maps published as not draft', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.draft).toBe(false);
  });

  it('derives hero image with first-image strategy', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'first-image');
    expect(fm.heroImage).toContain('hero.jpg');
    expect(fm.heroImage).toContain('../../assets/blog/');
  });

  it('skips hero with none strategy', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'none');
    expect(fm.heroImage).toBeUndefined();
  });

  it('preserves squarespace link', () => {
    const fm = mapSquarespaceFrontmatter(baseItem, 'none');
    expect(fm.squarespaceLink).toBe('https://mysite.squarespace.com/blog/test-post');
  });

  it('handles empty excerpt', () => {
    const noExcerpt = { ...baseItem, excerpt: '' };
    const fm = mapSquarespaceFrontmatter(noExcerpt, 'none');
    expect(fm.description).toBeUndefined();
  });
});

// ── Feature Mapping ──────────────────────────────────────────────────────

describe('mapSquarespaceFeaturesToAstro', () => {
  it('maps blog to @astrojs/rss', () => {
    const plugins = [{ gatsbyPlugin: 'blog', needsReview: false }];
    const result = mapSquarespaceFeaturesToAstro(plugins);
    expect(plugins[0].astroEquivalent).toBe('@astrojs/rss');
    expect(result.mapped).toBe(1);
  });

  it('maps sitemap to @astrojs/sitemap', () => {
    const plugins = [{ gatsbyPlugin: 'sitemap', needsReview: false }];
    const result = mapSquarespaceFeaturesToAstro(plugins);
    expect(plugins[0].astroEquivalent).toBe('@astrojs/sitemap');
    expect(result.mapped).toBe(1);
  });

  it('flags gallery-block as needsReview', () => {
    const plugins = [{ gatsbyPlugin: 'gallery-block', needsReview: false }];
    const result = mapSquarespaceFeaturesToAstro(plugins);
    expect(plugins[0].needsReview).toBe(true);
    expect(result.unmapped).toContain('gallery-block');
  });

  it('reports unmapped for unknown features', () => {
    const plugins = [{ gatsbyPlugin: 'unknown-feature', needsReview: false }];
    const result = mapSquarespaceFeaturesToAstro(plugins);
    expect(result.unmapped).toContain('unknown-feature');
  });
});

// ── Transform ─────────────────────────────────────────────────────────────

describe('transformSquarespaceContent', () => {
  const xml = readFileSync(WXR_PATH, 'utf-8');
  const wxr = parseWxr(xml);

  it('counts mapped fields', () => {
    const result = transformSquarespaceContent(wxr.items);
    expect(result.mapped).toBeGreaterThan(0);
  });

  it('tracks HTML→Markdown rewrites', () => {
    const result = transformSquarespaceContent(wxr.items);
    const htmlRewrites = result.rewrites.filter(r => r.type === 'other' && r.from === 'HTML body');
    expect(htmlRewrites.length).toBeGreaterThan(0);
  });

  it('tracks CDN image rewrites', () => {
    const result = transformSquarespaceContent(wxr.items);
    const imgRewrites = result.rewrites.filter(r => r.type === 'image');
    expect(imgRewrites.length).toBeGreaterThan(0);
  });
});

// ── WXR Items Sidecar ────────────────────────────────────────────────────

describe('WXR items sidecar', () => {
  it('writes and reads WXR items', () => {
    const tmpDir = resolve(FIXTURES, 'squarespace-export', 'tmp-sidecar');
    const items: WxrItem[] = [
      {
        title: 'Test',
        postName: 'test',
        postType: 'post',
        content: 'hello',
        excerpt: '',
        pubDate: '',
        postDate: '',
        postDateGmt: '',
        status: 'publish',
        tags: [],
        categories: [],
        creator: '',
        link: '',
        postId: 0,
        postParent: 0,
        attachmentUrl: '',
        postPassword: '',
        isSticky: false,
        postMeta: [],
        comments: [],
      },
    ];
    writeWxrItems(items, tmpDir);
    const read = readWxrItems(tmpDir);
    expect(read.length).toBe(1);
    expect(read[0].title).toBe('Test');
  });
});

// ── Full Extraction ──────────────────────────────────────────────────────

describe('extractSquarespace', () => {
  it('extracts from WXR file and returns manifest', async () => {
    const result = await extractSquarespace({
      export: WXR_PATH,
      to: resolve(FIXTURES, 'squarespace-export'),
    });
    expect(result.manifest.source.platform).toBe('squarespace');
    expect(result.manifest.extract.counts.posts).toBe(3);
    expect(result.manifest.extract.counts.pages).toBe(1);
    expect(result.manifest.extract.counts.images).toBeGreaterThanOrEqual(3);
    expect(result.wxrItems.length).toBe(4);
  });

  it('throws for missing export file', async () => {
    await expect(
      extractSquarespace({ export: '/nonexistent.xml', to: '/tmp' })
    ).rejects.toThrow('Export file not found');
  });

  it('maps features in manifest', async () => {
    const result = await extractSquarespace({
      export: WXR_PATH,
      to: resolve(FIXTURES, 'squarespace-export'),
    });
    expect(result.manifest.extract.plugins.length).toBeGreaterThan(0);
  });
});

// ── Field Key Map ────────────────────────────────────────────────────────

describe('SQUARESPACE_FIELD_KEY_MAP', () => {
  it('maps all expected WXR fields', () => {
    expect(SQUARESPACE_FIELD_KEY_MAP.title).toBe('title');
    expect(SQUARESPACE_FIELD_KEY_MAP.excerpt).toBe('description');
    expect(SQUARESPACE_FIELD_KEY_MAP.tags).toBe('tags');
    expect(SQUARESPACE_FIELD_KEY_MAP.categories).toBe('categories');
    expect(SQUARESPACE_FIELD_KEY_MAP.creator).toBe('authors');
    expect(SQUARESPACE_FIELD_KEY_MAP.status).toBe('draft');
  });
});
