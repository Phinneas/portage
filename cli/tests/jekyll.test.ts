import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJekyll, parseYaml, parsePostFilename, deriveSlug, detectLiquidTags, convertLiquidTags, resolvePermalinkPattern, expandPermalink } from '../src/jekyll.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/jekyll-project');

describe('extract --from jekyll', () => {
  it('should extract content files from a Jekyll project', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    expect(result.manifest.source.platform).toBe('jekyll');
    expect(result.manifest.extract.contentFiles.length).toBeGreaterThan(0);
  });

  it('should find blog posts in _posts/', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    expect(result.manifest.extract.counts.posts).toBeGreaterThanOrEqual(2);
  });

  it('should find pages at the project root', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    expect(result.manifest.extract.counts.pages).toBeGreaterThanOrEqual(1);
  });

  it('should parse _config.yml plugins', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    expect(result.manifest.extract.plugins.length).toBeGreaterThanOrEqual(3);
    const pluginNames = result.manifest.extract.plugins.map((p) => p.gatsbyPlugin);
    expect(pluginNames).toContain('jekyll-feed');
    expect(pluginNames).toContain('jekyll-seo-tag');
    expect(pluginNames).toContain('jekyll-sitemap');
  });

  it('should map Jekyll plugins to Astro equivalents', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    const feed = result.manifest.extract.plugins.find((p) => p.gatsbyPlugin === 'jekyll-feed');
    expect(feed?.astroEquivalent).toBe('@astrojs/rss');
    const sitemap = result.manifest.extract.plugins.find((p) => p.gatsbyPlugin === 'jekyll-sitemap');
    expect(sitemap?.astroEquivalent).toBe('@astrojs/sitemap');
  });

  it('should discover custom collections', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    const collections = new Set(result.manifest.extract.contentFiles.map((f) => f.collection));
    expect(collections).toContain('projects');
  });

  it('should exclude drafts without --include-drafts', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true, includeDrafts: false });
    const draftFiles = result.manifest.extract.contentFiles.filter((f) => f.relativePath.startsWith('_drafts/'));
    expect(draftFiles.length).toBe(0);
  });

  it('should include drafts with --include-drafts', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true, includeDrafts: true });
    const draftFiles = result.manifest.extract.contentFiles.filter((f) => f.relativePath.startsWith('_drafts/'));
    expect(draftFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('should collect images from assets/', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    expect(result.manifest.extract.counts.images).toBeGreaterThanOrEqual(2);
  });

  it('should extract tags and categories from frontmatter', async () => {
    const result = await extractJekyll({ source: FIXTURE, to: '/tmp/jekyll-test', dryRun: true });
    expect(result.manifest.extract.counts.tags).toBeGreaterThan(0);
  });
});

describe('Jekyll YAML parser', () => {
  it('should parse simple key-value pairs', () => {
    const result = parseYaml('title: My Site\ndescription: A test site');
    expect(result.title).toBe('My Site');
    expect(result.description).toBe('A test site');
  });

  it('should parse arrays', () => {
    const result = parseYaml('plugins:\n  - jekyll-feed\n  - jekyll-sitemap');
    expect(result.plugins).toEqual(['jekyll-feed', 'jekyll-sitemap']);
  });

  it('should parse nested objects', () => {
    const result = parseYaml('collections:\n  projects:\n    output: true\n    permalink: /:collection/:name');
    const collections = result.collections as Record<string, Record<string, unknown>>;
    expect(collections.projects.output).toBe(true);
    expect(collections.projects.permalink).toBe('/:collection/:name');
  });

  it('should parse booleans and numbers', () => {
    const result = parseYaml('show_excerpts: true\npaginate: 5');
    expect(result.show_excerpts).toBe(true);
    expect(result.paginate).toBe(5);
  });
});

describe('Jekyll post filename parsing', () => {
  it('should extract date and slug from YYYY-MM-DD-slug.md', () => {
    const { date, slug } = parsePostFilename('2024-06-15-welcome-to-jekyll.md');
    expect(date).toBe('2024-06-15');
    expect(slug).toBe('welcome-to-jekyll');
  });

  it('should handle filenames without date prefix', () => {
    const { date, slug } = parsePostFilename('my-draft.md');
    expect(date).toBeNull();
    expect(slug).toBe('my-draft');
  });
});

describe('Jekyll slug derivation', () => {
  it('should derive slug from _posts/ with date prefix', () => {
    expect(deriveSlug('_posts/2024-06-15-welcome-to-jekyll.md')).toBe('welcome-to-jekyll');
  });

  it('should derive slug from _drafts/ without date prefix', () => {
    expect(deriveSlug('_drafts/work-in-progress.md')).toBe('work-in-progress');
  });

  it('should derive slug from custom collections', () => {
    expect(deriveSlug('_projects/astro-migration-tool.md')).toBe('astro-migration-tool');
  });

  it('should derive slug from top-level pages', () => {
    expect(deriveSlug('about.md')).toBe('about');
  });
});

describe('Liquid tag detection', () => {
  it('should detect highlight tags', () => {
    const body = '{% highlight ruby %}puts "hi"{% endhighlight %}';
    const result = detectLiquidTags(body);
    expect(result.highlight).toBe(1);
  });

  it('should detect include tags', () => {
    const body = '{% include footer.html %}';
    const result = detectLiquidTags(body);
    expect(result.include).toBe(1);
  });

  it('should detect post_url tags', () => {
    const body = '{% post_url 2024-06-15-welcome %}';
    const result = detectLiquidTags(body);
    expect(result.postUrl).toBe(1);
  });

  it('should detect template variables', () => {
    const body = '{{ page.title }} and {{ site.url }}';
    const result = detectLiquidTags(body);
    expect(result.variable).toBe(2);
  });

  it('should count total Liquid tags', () => {
    const body = '{% highlight ruby %}code{% endhighlight %}\n{% include footer.html %}\n{{ page.title }}';
    const result = detectLiquidTags(body);
    expect(result.total).toBeGreaterThan(0);
  });
});

describe('Liquid tag conversion', () => {
  it('should convert highlight to fenced code blocks', () => {
    const body = '{% highlight ruby %}puts "hi"{% endhighlight %}';
    expect(convertLiquidTags(body)).toBe('```ruby\nputs "hi"\n```');
  });

  it('should convert post_url to relative links', () => {
    const body = '{% post_url 2024-06-15-welcome-to-jekyll %}';
    expect(convertLiquidTags(body)).toBe('/blog/welcome-to-jekyll/');
  });

  it('should convert include to HTML comments', () => {
    const body = '{% include footer.html %}';
    expect(convertLiquidTags(body)).toBe('<!-- include: footer.html -->');
  });

  it('should convert template variables to HTML comments', () => {
    const body = '{{ page.title }}';
    expect(convertLiquidTags(body)).toBe('<!-- variable: title -->');
  });

  it('should unwrap raw blocks', () => {
    const body = '{% raw %}{{ not_processed }}{% endraw %}';
    expect(convertLiquidTags(body)).toBe('{{ not_processed }}');
  });
});

describe('Permalink resolution', () => {
  it('should resolve built-in permalink styles', () => {
    expect(resolvePermalinkPattern('pretty')).toBe('/:categories/:year/:month/:day/:title/');
    expect(resolvePermalinkPattern('date')).toBe('/:categories/:year/:month/:day/:title.html');
    expect(resolvePermalinkPattern('none')).toBe('/:categories/:title.html');
  });

  it('should default to pretty when no permalink set', () => {
    expect(resolvePermalinkPattern(undefined)).toBe('/:categories/:year/:month/:day/:title/');
  });

  it('should pass through custom patterns', () => {
    expect(resolvePermalinkPattern('/:year/:month/:title/')).toBe('/:year/:month/:title/');
  });

  it('should expand permalink placeholders', () => {
    const url = expandPermalink('/:year/:month/:day/:title/', {
      year: '2024', month: '06', day: '15', title: 'welcome-to-jekyll',
    });
    expect(url).toBe('/2024/06/15/welcome-to-jekyll/');
  });

  it('should expand :categories placeholder', () => {
    const url = expandPermalink('/:categories/:title/', {
      categories: ['ruby', 'tutorial'], title: 'my-post',
    });
    expect(url).toBe('/ruby/tutorial/my-post/');
  });
});
