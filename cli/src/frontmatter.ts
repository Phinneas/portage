/**
 * Shared frontmatter parsing, serialization, and type coercion.
 * Single source of truth for the Gatsby → Astro field mapping table.
 */

// ── Field mapping (spec §03) ──────────────────────────────────────────

export const FIELD_MAP: Record<string, { astro: string; transform?: (v: unknown) => unknown }> = {
  // Plain YAML keys (what the parser actually produces)
  title:            { astro: 'title' },
  slug:             { astro: '_slug' },
  excerpt:          { astro: 'description' },
  description:      { astro: 'description' },
  date:             { astro: 'pubDate',    transform: (v) => coerceDate(v) },
  publishedDate:    { astro: 'pubDate',    transform: (v) => coerceDate(v) },
  updated:          { astro: 'updatedDate', transform: (v) => coerceDate(v) },
  updatedDate:      { astro: 'updatedDate', transform: (v) => coerceDate(v) },
  tags:             { astro: 'tags',       transform: (v) => ensureArray(v) },
  category:         { astro: 'categories', transform: (v) => ensureArray(v) },
  author:           { astro: 'authors',    transform: (v) => ensureArray(v) },
  authors:          { astro: 'authors',    transform: (v) => ensureArray(v) },
  featuredImage:    { astro: 'heroImage' },
  imageAlt:         { astro: 'heroImageAlt' },
  draft:            { astro: 'draft',      transform: (v) => coerceBoolean(v) },
  canonical_url:    { astro: 'canonicalURL' },
  readingTime:      { astro: 'readingTime', transform: (v) => Number(v) || undefined },
  timeToRead:       { astro: 'timeToRead',  transform: (v) => Number(v) || undefined },
  // Dotted spec notation (frontmatter.xxx, fields.xxx) for GraphQL-sourced fields
  'frontmatter.title':           { astro: 'title' },
  'frontmatter.slug':            { astro: '_slug' },
  'fields.slug':                 { astro: '_slug' },
  'frontmatter.excerpt':         { astro: 'description' },
  'frontmatter.description':     { astro: 'description' },
  'frontmatter.date':            { astro: 'pubDate',    transform: (v) => coerceDate(v) },
  'frontmatter.publishedDate':   { astro: 'pubDate',    transform: (v) => coerceDate(v) },
  'frontmatter.updated':         { astro: 'updatedDate', transform: (v) => coerceDate(v) },
  'frontmatter.updatedDate':     { astro: 'updatedDate', transform: (v) => coerceDate(v) },
  'frontmatter.tags':            { astro: 'tags',       transform: (v) => ensureArray(v) },
  'frontmatter.category':        { astro: 'categories', transform: (v) => ensureArray(v) },
  'frontmatter.author':          { astro: 'authors',    transform: (v) => ensureArray(v) },
  'frontmatter.authors':         { astro: 'authors',    transform: (v) => ensureArray(v) },
  'frontmatter.featuredImage':   { astro: 'heroImage' },
  'frontmatter.imageAlt':        { astro: 'heroImageAlt' },
  'frontmatter.draft':           { astro: 'draft',      transform: (v) => coerceBoolean(v) },
  'frontmatter.canonical_url':   { astro: 'canonicalURL' },
  'fields.readingTime':          { astro: 'readingTime', transform: (v) => Number(v) || undefined },
  'fields.timeToRead':           { astro: 'timeToRead',  transform: (v) => Number(v) || undefined },
  'frontmatter.seo.title':       { astro: 'seo.title' },
  'frontmatter.seo.description': { astro: 'seo.description' },
};

/** Simple key→key mapping used by the collection writer (no transforms, those happen inline). */
export const FIELD_KEY_MAP: Record<string, string> = {
  title: 'title',
  description: 'description',
  excerpt: 'description',
  date: 'pubDate',
  publishedDate: 'pubDate',
  updated: 'updatedDate',
  updatedDate: 'updatedDate',
  tags: 'tags',
  category: 'categories',
  categories: 'categories',
  author: 'authors',
  authors: 'authors',
  featuredImage: 'heroImage',
  imageAlt: 'heroImageAlt',
  draft: 'draft',
  canonical_url: 'canonicalURL',
  readingTime: 'readingTime',
  timeToRead: 'timeToRead',
};

// ── Parse & split ──────────────────────────────────────────────────────

export function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: parseFrontmatter(match[1]), body: match[2] };
}

export function parseFrontmatter(fmStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of fmStr.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      const [, key, val] = kv;
      // Handle YAML inline arrays like [val1, val2]
      if (/^\[.*\]$/.test(val.trim())) {
        try {
          result[key] = JSON.parse(val.replace(/'/g, '"'));
        } catch {
          // Fallback: strip brackets and split
          const inner = val.replace(/^\[/, '').replace(/\]$/, '');
          result[key] = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        }
      } else {
        try {
          result[key] = JSON.parse(val);
        } catch {
          result[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  }
  return result;
}

// ── Serialize ──────────────────────────────────────────────────────────

export function serializeFrontmatter(fm: Record<string, unknown>): string {
  let out = '---\n';
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    out += `${key}: ${serializeValue(value)}\n`;
  }
  out += '---\n\n';
  return out;
}

function serializeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (needsQuoting(value)) return `"${value.replace(/"/g, '\\"')}"`;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => serializeValue(v)).join(', ')}]`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function needsQuoting(s: string): boolean {
  return /[:#"']/.test(s) ||
    /^[{}\[\]&*|>!%@`,]/.test(s) ||
    s === 'true' || s === 'false' || s === 'null';
}

// ── Coercion helpers ───────────────────────────────────────────────────

export function coerceDate(v: unknown): string | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toISOString().split('T')[0];
}

export function ensureArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return [v]; }
  }
  return [v];
}

export function coerceBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}
