/**
 * Shared pipeline contracts for the Portage migration toolkit.
 * Every platform implements these interfaces so that extract, transform,
 * and load produce identical-quality output regardless of source.
 *
 * This is the normalization layer that closes the ETL parity gap.
 */

// ── Shared Frontmatter ────────────────────────────────────────────────

/** Every platform must produce all these fields in its frontmatter output. */
export interface SharedFrontmatter {
  title: string;
  slug?: string;            // _slug for Astro content collections
  pubDate?: string;         // ISO date string
  updatedDate?: string;     // ISO date string
  tags?: string[];
  authors?: string[];
  heroImage?: string;       // relative path (../../assets/blog/filename) or URL
  heroImageAlt?: string;
  heroImageCaption?: string;
  description?: string;
  draft?: boolean;
  featured?: boolean;
  access?: 'public' | 'members' | 'paid';
  canonicalURL?: string;
  seo?: {
    title?: string;
    description?: string;
    image?: string;
  };
  originalId?: string;      // UUID or native ID from source platform
  lexicalReview?: boolean;  // true when structured content (Lexical etc.) was bypassed
  /** Platform-specific extras that don't map to standard fields */
  source?: Record<string, unknown>;
}

// ── Shared Settings ────────────────────────────────────────────────────

/** Every platform extracts site metadata into this shape. */
export interface SharedSettings {
  title: string;
  description: string;
  url: string;
  locale?: string;
  timezone?: string;
  navigation?: Array<{ label: string; url: string }>;
  logo?: string;
  icon?: string;
  coverImage?: string;
  codeinjectionHead?: string;
  codeinjectionFoot?: string;
}

// ── Content Item ───────────────────────────────────────────────────────

/** Normalized content item produced by every platform's extract phase. */
export interface ContentItem {
  originalId: string;             // UUID, WXR post_id, CSV post_id, file hash, etc.
  type: 'post' | 'page' | 'draft';
  slug: string;
  title: string;
  frontmatter: SharedFrontmatter;
  body: string;                   // Markdown or HTML (to be converted in load)
  bodyFormat: 'markdown' | 'html';
  hasStructuredContent: boolean;  // Lexical, Mobiledoc, Gutenberg blocks, etc.
  /** Platform-specific raw data preserved for destination-specific loaders */
  source: Record<string, unknown>;
}

// ── Image Item ─────────────────────────────────────────────────────────

export interface ImageItem {
  originalUrl: string;
  relativePath: string;
  source: 'src/images' | 'static' | 'remote' | 'next/image' | 'public';
  checksum?: string;
}

// ── Extract Result ─────────────────────────────────────────────────────

/** Every platform's extract function returns this normalized shape. */
export interface PipelineExtractResult {
  manifest: import('./manifest.js').Manifest;
  settings: SharedSettings;
  content: ContentItem[];
  images: ImageItem[];
  sidecarPath: string;
}

// ── Collection Writer Result ───────────────────────────────────────────

export interface CollectionResult {
  written: number;
  skippedDrafts: number;
  lexicalFlagged: number;
  quarantined: QuarantinedEntry[];
}

export interface QuarantinedEntry {
  slug: string;
  title: string;
  originalUrl?: string;
  reason: string;
  stage: 'extract' | 'transform' | 'load';
}

// ── Helper: empty settings fallback ─────────────────────────────────────

export function emptySettings(url?: string): SharedSettings {
  return {
    title: '',
    description: '',
    url: url || 'https://example.com',
    locale: 'en',
    timezone: 'UTC',
    navigation: [],
  };
}
