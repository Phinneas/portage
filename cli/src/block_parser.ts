/**
 * Shared block parser. Normalizes content blocks from any source format
 * (HTML, Markdown, MDX) into a common intermediate representation.
 *
 * Provides:
 *   - HTML → Markdown conversion (via Turndown, used by Squarespace + Substack)
 *   - HTML → Sanity Portable Text conversion (used by Squarespace → Sanity)
 *   - Platform-specific markup stripping (sqs-block, subscribe-widget, etc.)
 *
 * This is part of the portage-core shared pipeline.
 */

import TurndownService from 'turndown';

// ── Types ───────────────────────────────────────────────────────────────

export interface ContentBlock {
  type: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code' | 'image' | 'html';
  content: string;
  level?: number;        // heading level 1-6
  listType?: 'bullet' | 'number';
  src?: string;          // image URL
  alt?: string;          // image alt text
  language?: string;     // code language
  marks?: string[];      // inline marks: strong, em, link
  href?: string;         // link URL for mark
}

// ── Turndown Instance (shared configuration) ────────────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Register rules for platform-specific wrappers
turndown.addRule('sqsBlock', {
  filter: (node) => {
    if (node.nodeName === 'DIV') {
      const cls = node.getAttribute('class') || '';
      return cls.includes('sqs-block');
    }
    return false;
  },
  replacement: (_content, node) => {
    return '\n' + turndown.turndown(node.innerHTML || '') + '\n';
  },
});

turndown.addRule('inlineStyle', {
  filter: (node) => {
    return node.getAttribute && node.getAttribute('style') !== null;
  },
  replacement: (content, node) => {
    if (node.nodeName === 'SPAN' || node.nodeName === 'DIV') return content;
    return content;
  },
});

// ── HTML → Markdown ────────────────────────────────────────────────────

export function convertHtmlToMarkdown(html: string, platform?: 'squarespace' | 'substack' | 'generic'): string {
  if (!html || !html.includes('<')) return html;

  let cleaned = html;

  if (platform === 'squarespace' || platform === 'generic') {
    cleaned = stripSquarespaceMarkup(cleaned);
  }

  if (platform === 'substack') {
    cleaned = stripSubstackMarkup(cleaned);
  }

  return turndown.turndown(cleaned);
}

// ── Platform-Specific Markup Stripping ───────────────────────────────────

export function stripSquarespaceMarkup(html: string): string {
  return html
    .replace(/<div\s+class="[^"]*sqs-block[^"]*"[^>]*>/g, '')
    .replace(/<div\s+class="[^"]*sqs-block-html[^"]*"[^>]*>/g, '')
    .replace(/<\/div>\s*<!--\s*end\s+sqs-block[^*]*-->/g, '')
    .replace(/class="[^"]*sqs-[^"]*"/g, '')
    .replace(/style="[^"]*"/g, '')
    .replace(/data-[a-z-]+="[^"]*"/g, '');
}

export function stripSubstackMarkup(html: string): string {
  return html
    .replace(/<div\s+class="[^"]*subscribe-widget[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div\s+class="[^"]*subscription-widget[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/class="[^"]*mention-wrap[^"]*"/g, '')
    .replace(/data-attrs="[^"]*"/g, '');
}

// ── HTML → Sanity Portable Text ─────────────────────────────────────────

/** CDN base for Squarespace images */
export const SQSP_CDN_BASE = 'images.squarespace-cdn.com';

/**
 * Converts HTML content to Sanity Portable Text blocks.
 * For Squarespace, HTML is relatively clean (no shortcodes, no WP-specific markup).
 */
export function htmlToPortableText(html: string): unknown[] {
  if (!html || !html.trim()) return [];

  const cleaned = stripSquarespaceMarkup(html);
  const blocks: unknown[] = [];

  // Split on block-level elements
  const blockRe = /<(h[1-6]|p|blockquote|ul|ol|pre|hr)[^>]*>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      const between = cleaned.slice(lastIndex, match.index).trim();
      if (between) {
        blocks.push({
          _type: 'block',
          style: 'normal',
          children: [{ _type: 'span', marks: [], text: stripTags(between) }],
          markDefs: [],
        });
      }
    }

    const tag = match[1];
    const content = match[2];

    if (tag.match(/^h(\d)$/)) {
      const level = parseInt(tag[1]);
      const style = level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : level === 4 ? 'h4' : 'h5';
      blocks.push({
        _type: 'block',
        style,
        children: [{ _type: 'span', marks: [], text: stripTags(content) }],
        markDefs: [],
      });
    } else if (tag === 'p') {
      blocks.push({
        _type: 'block',
        style: 'normal',
        children: [{ _type: 'span', marks: [], text: stripTags(content) }],
        markDefs: [],
      });
    } else if (tag === 'blockquote') {
      blocks.push({
        _type: 'block',
        style: 'blockquote',
        children: [{ _type: 'span', marks: [], text: stripTags(content) }],
        markDefs: [],
      });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = content.split(/<li[^>]*>/).filter((s) => s.trim());
      for (const li of items) {
        blocks.push({
          _type: 'block',
          style: 'normal',
          listItem: tag === 'ol' ? 'number' : 'bullet',
          children: [{ _type: 'span', marks: [], text: stripTags(li.replace(/<\/li>/g, '')) }],
          markDefs: [],
          level: 1,
        });
      }
    } else if (tag === 'pre') {
      blocks.push({
        _type: 'code',
        code: stripTags(content),
        language: '',
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleaned.length) {
    const remainder = cleaned.slice(lastIndex).trim();
    if (remainder) {
      blocks.push({
        _type: 'block',
        style: 'normal',
        children: [{ _type: 'span', marks: [], text: stripTags(remainder) }],
        markDefs: [],
      });
    }
  }

  // Handle images not wrapped in block elements
  const imgRe = /<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?[^>]*\/?>/g;
  while ((match = imgRe.exec(cleaned)) !== null) {
    const src = match[1];
    const alt = match[2] || '';
    if (src.includes(SQSP_CDN_BASE)) {
      const filename = basename(new URL(src).pathname);
      blocks.push({
        _type: 'image',
        _sanityAsset: `image@file:///assets/${filename}`,
        alt,
      });
    }
  }

  return blocks;
}

// ── Helpers ────────────────────────────────────────────────────────────

import { basename } from 'node:path';

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
