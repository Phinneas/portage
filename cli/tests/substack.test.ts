import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  parseCsv,
  deriveSlugFromPostId,
  convertHtmlToMarkdown,
  extractMentions,
  extractSubstackImages,
  mapSubstackFrontmatter,
  mapSubstackFeaturesToAstro,
  transformSubstackContent,
  writeSubstackPosts,
  readSubstackPosts,
  SUBSTACK_FIELD_KEY_MAP,
  SUBSTACK_CDN_PATTERNS,
} from '../src/substack.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const SUBSTACK_FIXTURES = resolve(FIXTURES, 'substack-export');

// ── CSV Parsing ──────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses a standard CSV with headers', () => {
    const csv = readFileSync(resolve(SUBSTACK_FIXTURES, 'posts.csv'), 'utf-8');
    const rows = parseCsv(csv);
    expect(rows.length).toBe(6);
    expect(rows[0].post_id).toBe('12345.leaving-the-walled-garden');
    expect(rows[0].title).toBe('Leaving the Walled Garden');
    expect(rows[0].type).toBe('newsletter');
  });

  it('parses subtitle field', () => {
    const csv = readFileSync(resolve(SUBSTACK_FIXTURES, 'posts.csv'), 'utf-8');
    const rows = parseCsv(csv);
    expect(rows[0].subtitle).toBe('Why we moved our newsletter off a hosted platform');
  });

  it('handles empty fields', () => {
    const csv = readFileSync(resolve(SUBSTACK_FIXTURES, 'posts.csv'), 'utf-8');
    const rows = parseCsv(csv);
    // Page type post has no subtitle
    const page = rows.find((r) => r.type === 'page');
    expect(page?.subtitle).toBe('');
  });

  it('handles quoted CSV values', () => {
    const csv = 'post_id,title,subtitle\n123.test,"Hello, World","A subtitle"\n';
    const rows = parseCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('Hello, World');
  });

  it('handles escaped quotes in CSV', () => {
    const csv = 'post_id,title\n123.test,"She said ""hello"""\n';
    const rows = parseCsv(csv);
    expect(rows[0].title).toBe('She said "hello"');
  });

  it('returns empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('post_id,title')).toEqual([]);
  });

  it('parses audience field', () => {
    const csv = readFileSync(resolve(SUBSTACK_FIXTURES, 'posts.csv'), 'utf-8');
    const rows = parseCsv(csv);
    const paid = rows.find((r) => r.audience === 'only_paid');
    expect(paid?.type).toBe('podcast');
    const members = rows.find((r) => r.audience === 'only_free');
    expect(members?.type).toBe('thread');
  });

  it('parses podcast fields', () => {
    const csv = readFileSync(resolve(SUBSTACK_FIXTURES, 'posts.csv'), 'utf-8');
    const rows = parseCsv(csv);
    const podcast = rows.find((r) => r.type === 'podcast');
    expect(podcast?.audio_url).toBe('https://cdn.substack.com/audio/episode1.mp3');
    expect(podcast?.podcast_duration).toBe('1800');
  });
});

// ── Slug Derivation ─────────────────────────────────────────────────────

describe('deriveSlugFromPostId', () => {
  it('extracts slug from standard post_id format', () => {
    expect(deriveSlugFromPostId('12345.my-post-slug')).toBe('my-post-slug');
  });

  it('extracts slug from multi-part post_id', () => {
    expect(deriveSlugFromPostId('67890.harbor-notes')).toBe('harbor-notes');
  });

  it('returns full postId when no dot separator', () => {
    expect(deriveSlugFromPostId('12345')).toBe('12345');
  });
});

// ── HTML to Markdown ────────────────────────────────────────────────────

describe('convertHtmlToMarkdown', () => {
  it('converts basic HTML to Markdown', () => {
    const html = '<h1>Title</h1><p>Paragraph text.</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Title');
    expect(md).toContain('Paragraph text');
  });

  it('strips subscribe widgets', () => {
    const html = '<p>Before</p><div class="subscribe-widget"><a href="/subscribe">Subscribe</a></div><p>After</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Before');
    expect(md).toContain('After');
    expect(md).not.toContain('Subscribe');
  });

  it('converts blockquotes', () => {
    const html = '<blockquote>A ship in harbor is safe.</blockquote>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('>');
    expect(md).toContain('A ship in harbor');
  });

  it('converts images to markdown', () => {
    const html = '<img src="https://substackcdn.com/image/test.jpg" alt="Test image" />';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('![Test image]');
  });

  it('returns plain text for non-HTML content', () => {
    expect(convertHtmlToMarkdown('Plain text')).toBe('Plain text');
  });

  it('returns empty for empty input', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
  });

  it('strips inline styles', () => {
    const html = '<p style="color: red; font-size: 16px;">Styled text</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Styled text');
    expect(md).not.toContain('color');
    expect(md).not.toContain('font-size');
  });
});

// ── Mention Extraction ───────────────────────────────────────────────────

describe('extractMentions', () => {
  it('extracts mention names from data-attrs', () => {
    const html = '<span class="mention-wrap" data-attrs="{&quot;name&quot;:&quot;Dana Reyes&quot;,&quot;id&quot;:16944057}">Dana Reyes</span>';
    const mentions = extractMentions(html);
    expect(mentions).toEqual(['Dana Reyes']);
  });

  it('extracts multiple mentions', () => {
    const html = `
      <span class="mention-wrap" data-attrs="{&quot;name&quot;:&quot;Alice&quot;,&quot;id&quot;:1}">Alice</span>
      <span class="mention-wrap" data-attrs="{&quot;name&quot;:&quot;Bob&quot;,&quot;id&quot;:2}">Bob</span>
    `;
    const mentions = extractMentions(html);
    expect(mentions).toEqual(['Alice', 'Bob']);
  });

  it('returns empty for no mentions', () => {
    expect(extractMentions('<p>No mentions here</p>')).toEqual([]);
  });

  it('skips malformed data-attrs', () => {
    const html = '<span class="mention-wrap" data-attrs="not-json">broken</span>';
    const mentions = extractMentions(html);
    expect(mentions).toEqual([]);
  });
});

// ── Image Extraction ─────────────────────────────────────────────────────

describe('extractSubstackImages', () => {
  it('extracts substackcdn.com images', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test',
      subtitle: '',
      url: '',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<img src="https://substackcdn.com/image/fetch/f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ftest_800x600.jpg" />',
    }];
    const images = extractSubstackImages(posts);
    expect(images.length).toBe(1);
    expect(images[0].source).toBe('remote');
  });

  it('extracts direct S3 images', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test',
      subtitle: '',
      url: '',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<img src="https://substack-post-media.s3.amazonaws.com/public/images/photo.jpg" />',
    }];
    const images = extractSubstackImages(posts);
    expect(images.length).toBe(1);
  });

  it('deduplicates images', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test',
      subtitle: '',
      url: '',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<img src="https://substackcdn.com/image/test.jpg" /><img src="https://substackcdn.com/image/test.jpg?w=400" />',
    }];
    const images = extractSubstackImages(posts);
    expect(images.length).toBe(1); // Same image, different resize params
  });

  it('ignores non-Substack images', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test',
      subtitle: '',
      url: '',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<img src="https://example.com/images/photo.jpg" />',
    }];
    const images = extractSubstackImages(posts);
    expect(images.length).toBe(0);
  });
});

// ── Frontmatter Mapping ──────────────────────────────────────────────────

describe('mapSubstackFrontmatter', () => {
  const basePost = {
    postId: '12345.my-post',
    slug: 'my-post',
    title: 'My Post',
    subtitle: 'A subtitle',
    url: 'https://my-pub.substack.com/p/my-post',
    postDate: '2025-11-18',
    isPublished: true,
    audience: 'public' as const,
    type: 'newsletter' as const,
    audioUrl: '',
    podcastDuration: 0,
    podcastUrl: '',
    html: '<p>Content</p>',
  };

  it('maps basic fields', () => {
    const fm = mapSubstackFrontmatter(basePost, 'first-image');
    expect(fm.title).toBe('My Post');
    expect(fm.description).toBe('A subtitle');
    expect(fm.pubDate).toBe('2025-11-18');
    expect(fm.draft).toBe(false);
    expect(fm.access).toBe('public');
    expect(fm.canonicalURL).toBe('https://my-pub.substack.com/p/my-post');
  });

  it('maps draft status', () => {
    const draft = { ...basePost, isPublished: false };
    const fm = mapSubstackFrontmatter(draft, 'first-image');
    expect(fm.draft).toBe(true);
  });

  it('maps audience to access levels', () => {
    const paid = { ...basePost, audience: 'only_paid' as const };
    expect(mapSubstackFrontmatter(paid, 'first-image').access).toBe('paid');

    const members = { ...basePost, audience: 'only_free' as const };
    expect(mapSubstackFrontmatter(members, 'first-image').access).toBe('members');
  });

  it('maps podcast fields', () => {
    const podcast = {
      ...basePost,
      type: 'podcast' as const,
      audioUrl: 'https://cdn.substack.com/audio/ep1.mp3',
      podcastDuration: 1800,
    };
    const fm = mapSubstackFrontmatter(podcast, 'first-image');
    expect(fm.audioUrl).toBe('https://cdn.substack.com/audio/ep1.mp3');
    expect(fm.audioDuration).toBe(1800);
  });

  it('does not map podcast fields for non-podcast types', () => {
    const fm = mapSubstackFrontmatter(basePost, 'first-image');
    expect(fm.audioUrl).toBeUndefined();
  });

  it('derives hero from first image', () => {
    const withImg = {
      ...basePost,
      html: '<img src="https://substackcdn.com/image/fetch/f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ftest.jpg" />',
    };
    const fm = mapSubstackFrontmatter(withImg, 'first-image');
    expect(fm.heroImage).toBeDefined();
    expect(String(fm.heroImage)).toContain('../../assets/blog/');
  });

  it('skips hero when strategy is none', () => {
    const withImg = {
      ...basePost,
      html: '<img src="https://substackcdn.com/image/test.jpg" />',
    };
    const fm = mapSubstackFrontmatter(withImg, 'none');
    expect(fm.heroImage).toBeUndefined();
  });

  it('preserves substack metadata', () => {
    const fm = mapSubstackFrontmatter(basePost, 'first-image');
    expect(fm.substackId).toBe('12345.my-post');
    expect(fm.substackType).toBe('newsletter');
  });
});

// ── Feature Mapping ──────────────────────────────────────────────────────

describe('mapSubstackFeaturesToAstro', () => {
  it('maps known features', () => {
    const plugins = [
      { gatsbyPlugin: 'blog', astroEquivalent: undefined, options: undefined, needsReview: false },
      { gatsbyPlugin: 'sitemap', astroEquivalent: undefined, options: undefined, needsReview: false },
    ];
    const result = mapSubstackFeaturesToAstro(plugins);
    expect(result.mapped).toBe(2);
    expect(plugins[0].astroEquivalent).toBe('@astrojs/rss');
    expect(plugins[1].astroEquivalent).toBe('@astrojs/sitemap');
  });

  it('flags unmapped features', () => {
    const plugins = [
      { gatsbyPlugin: 'subscribe-buttons', astroEquivalent: undefined, options: undefined, needsReview: false },
      { gatsbyPlugin: 'podcast', astroEquivalent: undefined, options: undefined, needsReview: false },
    ];
    const result = mapSubstackFeaturesToAstro(plugins);
    expect(result.unmapped.length).toBe(2);
  });

  it('handles unknown plugins', () => {
    const plugins = [
      { gatsbyPlugin: 'unknown-plugin', astroEquivalent: undefined, options: undefined, needsReview: false },
    ];
    const result = mapSubstackFeaturesToAstro(plugins);
    expect(result.unmapped).toContain('unknown-plugin');
  });
});

// ── Transform ────────────────────────────────────────────────────────────

describe('transformSubstackContent', () => {
  it('counts mapped fields', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test',
      subtitle: 'Sub',
      url: 'https://example.com',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<p>Content</p>',
    }];
    const result = transformSubstackContent(posts);
    expect(result.mapped).toBeGreaterThan(0);
  });

  it('detects CDN image rewrites', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test',
      subtitle: '',
      url: '',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<img src="https://substackcdn.com/image/test.jpg" />',
    }];
    const result = transformSubstackContent(posts);
    const imgRewrite = result.rewrites.find((r) => r.type === 'image');
    expect(imgRewrite).toBeDefined();
  });
});

// ── Sidecar Persistence ─────────────────────────────────────────────────

describe('writeSubstackPosts / readSubstackPosts', () => {
  const tmpDir = resolve(__dirname, 'fixtures', 'substack-tmp-test');

  it('writes and reads posts sidecar', () => {
    const posts = [{
      postId: '12345.test',
      slug: 'test',
      title: 'Test Post',
      subtitle: '',
      url: '',
      postDate: '2025-01-01',
      isPublished: true,
      audience: 'public' as const,
      type: 'newsletter' as const,
      audioUrl: '',
      podcastDuration: 0,
      podcastUrl: '',
      html: '<p>Content</p>',
    }];

    mkdirSync(tmpDir, { recursive: true });
    writeSubstackPosts(posts, tmpDir);
    const read = readSubstackPosts(tmpDir);
    expect(read.length).toBe(1);
    expect(read[0].title).toBe('Test Post');

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no sidecar exists', () => {
    expect(readSubstackPosts('/nonexistent')).toEqual([]);
  });
});

// ── Field Key Map ────────────────────────────────────────────────────────

describe('SUBSTACK_FIELD_KEY_MAP', () => {
  it('maps all expected fields', () => {
    expect(SUBSTACK_FIELD_KEY_MAP.title).toBe('title');
    expect(SUBSTACK_FIELD_KEY_MAP.subtitle).toBe('description');
    expect(SUBSTACK_FIELD_KEY_MAP.postDate).toBe('pubDate');
    expect(SUBSTACK_FIELD_KEY_MAP.isPublished).toBe('draft');
    expect(SUBSTACK_FIELD_KEY_MAP.audience).toBe('access');
    expect(SUBSTACK_FIELD_KEY_MAP.url).toBe('canonicalURL');
    expect(SUBSTACK_FIELD_KEY_MAP.audioUrl).toBe('audioUrl');
    expect(SUBSTACK_FIELD_KEY_MAP.podcastDuration).toBe('audioDuration');
  });
});

// ── CDN Patterns ───────────────────────────────────────────────────────

describe('SUBSTACK_CDN_PATTERNS', () => {
  it('includes substackcdn.com', () => {
    expect(SUBSTACK_CDN_PATTERNS).toContain('substackcdn.com');
  });

  it('includes direct S3 domain', () => {
    expect(SUBSTACK_CDN_PATTERNS).toContain('substack-post-media.s3.amazonaws.com');
  });
});
