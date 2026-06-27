/**
 * Creatives template registry and handoff link generator.
 *
 * After a CMS-to-CMS migration completes, Portage outputs a link to the
 * matching Salish Sea Creatives template -- an Astro project pre-wired to
 * the destination CMS. This is the cross-sell flywheel:
 *
 *   WordPress → Payload migration → "Here is the Astro + Payload template"
 *   Ghost → Payload migration     → "Here is the Astro + Payload template"
 *   Contentful → Sanity migration → "Here is the Astro + Sanity template"
 *   Storyblok → Keystatic migration → "Here is the Astro + Keystatic template"
 *
 * For Astro-only routes (Gatsby→Astro, Jekyll→Astro, etc.), the handoff
 * links to the base Astro blog template.
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface CreativesTemplate {
  /** URL-friendly slug (e.g. "astro-payload") */
  slug: string;
  /** Human-readable name */
  name: string;
  /** Full URL to the template page on Salish Sea Creatives */
  url: string;
  /** Which destination CMS this template pairs with */
  destination: 'payload' | 'sanity' | 'keystatic' | 'astro';
  /** Which source platforms this template is relevant for */
  sourcePlatforms: string[];
  /** Whether this template is free (lead-gen) or paid */
  pricing: 'free' | 'paid';
  /** Short description for CLI output */
  description: string;
}

export interface HandoffResult {
  template: CreativesTemplate | null;
  link: string;
  message: string;
}

export interface MigrationReport {
  version: '1';
  source: {
    platform: string;
    exportFile?: string;
  };
  destination: {
    platform: string;
    method: string;
  };
  summary: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    imagesDownloaded: number;
    imagesFailed: number;
    redirects: number;
    skippedDrafts: number;
  };
  output: {
    seedScript?: string;
    config?: string;
    mediaDir?: string;
    envFile?: string;
  };
  handoff: {
    templateSlug: string | null;
    templateName: string | null;
    templateUrl: string | null;
    pricing: 'free' | 'paid' | null;
  };
  completedAt: string;
}

// ── Template Registry ───────────────────────────────────────────────────

const CREATIVES_BASE = 'https://creatives.salishsea.consulting/templates';

export const TEMPLATES: CreativesTemplate[] = [
  {
    slug: 'astro-payload',
    name: 'Astro + Payload',
    url: `${CREATIVES_BASE}/astro-payload`,
    destination: 'payload',
    sourcePlatforms: ['ghost', 'wordpress', 'squarespace'],
    pricing: 'paid',
    description: 'Pre-configured Payload CMS with SQLite, admin panel, and an Astro frontend querying the Local API.',
  },
  {
    slug: 'astro-sanity',
    name: 'Astro + Sanity',
    url: `${CREATIVES_BASE}/astro-sanity`,
    destination: 'sanity',
    sourcePlatforms: ['contentful'],
    pricing: 'paid',
    description: 'Sanity Studio with generated schema definitions and an Astro frontend querying GROQ.',
  },
  {
    slug: 'astro-keystatic',
    name: 'Astro + Keystatic',
    url: `${CREATIVES_BASE}/astro-keystatic`,
    destination: 'keystatic',
    sourcePlatforms: ['storyblok'],
    pricing: 'free',
    description: 'File-based CMS with Keystatic configured, keystatic.config.ts, and an Astro frontend rendering Markdoc. Zero cost.',
  },
  {
    slug: 'astro-blog',
    name: 'Astro Blog',
    url: `${CREATIVES_BASE}/astro-blog`,
    destination: 'astro',
    sourcePlatforms: ['gatsby', 'jekyll', 'next', 'substack', 'webflow', 'wordpress'],
    pricing: 'free',
    description: 'Starter Astro blog template with content collections, image optimization, and SEO defaults.',
  },
];

// ── Template Matching ────────────────────────────────────────────────────

/**
 * Find the best Creatives template for a given source → destination pair.
 *
 * Priority:
 *   1. Exact match on destination CMS (payload/sanity/keystatic)
 *   2. Fallback to the generic astro-blog template for Astro destinations
 */
export function findTemplate(
  sourcePlatform: string,
  destinationPlatform: string,
): CreativesTemplate | null {
  // 1. Try exact destination match with source overlap
  const exactMatch = TEMPLATES.find(
    (t) =>
      t.destination === destinationPlatform &&
      t.sourcePlatforms.includes(sourcePlatform),
  );
  if (exactMatch) return exactMatch;

  // 2. Try any template matching the destination (source-agnostic)
  const destMatch = TEMPLATES.find((t) => t.destination === destinationPlatform);
  if (destMatch) return destMatch;

  // 3. Astro destination → generic blog template
  if (destinationPlatform === 'astro') {
    return TEMPLATES.find((t) => t.slug === 'astro-blog') || null;
  }

  return null;
}

// ── Handoff Link Generation ──────────────────────────────────────────────

export function generateHandoff(
  sourcePlatform: string,
  destinationPlatform: string,
): HandoffResult {
  const template = findTemplate(sourcePlatform, destinationPlatform);

  if (!template) {
    return {
      template: null,
      link: '',
      message: 'No paired template found for this route. Build your own Astro frontend or request one at Salish Sea Consulting.',
    };
  }

  const link = template.url;
  const pricing = template.pricing === 'free' ? 'free' : 'available';
  const message = template.pricing === 'free'
    ? `Next step: Clone the ${template.name} template (free). Pre-wired for your new CMS. → ${link}`
    : `Next step: The ${template.name} template is ${pricing} from Salish Sea Creatives. Pre-wired for your new CMS. → ${link}`;

  return { template, link, message };
}

// ── Migration Report Generation ─────────────────────────────────────────

export function generateMigrationReport(
  sourcePlatform: string,
  destinationPlatform: string,
  method: string,
  counts: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    imagesDownloaded: number;
    imagesFailed: number;
    redirects: number;
    skippedDrafts: number;
  },
  output: {
    seedScript?: string;
    config?: string;
    mediaDir?: string;
    envFile?: string;
  },
  exportFile?: string,
): MigrationReport {
  const handoff = generateHandoff(sourcePlatform, destinationPlatform);

  return {
    version: '1',
    source: {
      platform: sourcePlatform,
      exportFile,
    },
    destination: {
      platform: destinationPlatform,
      method,
    },
    summary: counts,
    output,
    handoff: {
      templateSlug: handoff.template?.slug || null,
      templateName: handoff.template?.name || null,
      templateUrl: handoff.template?.url || null,
      pricing: handoff.template?.pricing || null,
    },
    completedAt: new Date().toISOString(),
  };
}

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function writeMigrationReport(
  report: MigrationReport,
  targetDir: string,
): string {
  const path = resolve(targetDir, 'migration-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return path;
}
