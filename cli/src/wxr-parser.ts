/**
 * Shared WXR (WordPress eXtended RSS) parser.
 *
 * Squarespace exports use the WXR format, identical to WordPress exports.
 * This module owns all generic WXR parsing so that both squarespace2astro
 * and a future wordpress2astro can share the same XML → item extraction.
 *
 * Platform-specific concerns (sqs-block stripping, CDN image handling,
 * WordPress comment parsing, etc.) live in their respective platform files.
 *
 * ADR-001: Shared WXR parser for Squarespace + WordPress routes.
 * See cli/docs/adr/001-wxr-parser.md for the decision record.
 */

import { XMLParser } from 'fast-xml-parser';
import { ensureArray } from './frontmatter.js';

// ── Public types ───────────────────────────────────────────────────────

export interface WxrItem {
  title: string;
  postName: string;
  postType: WxrPostType;
  content: string;        // HTML from content:encoded
  excerpt: string;        // HTML from excerpt:encoded
  pubDate: string;
  postDate: string;
  postDateGmt: string;
  status: WxrStatus;
  tags: string[];         // category domain="post_tag"
  categories: string[];   // category domain="category"
  creator: string;        // dc:creator
  link: string;
  postId: number;
  postParent: number;
  attachmentUrl: string;  // wp:attachment_url (WordPress media)
  postPassword: string;
  isSticky: boolean;
  postMeta: WxrPostMeta[];
  comments: WxrComment[];
}

export type WxrPostType = 'post' | 'page' | 'attachment' | 'revision' | 'nav_menu_item' | string;
export type WxrStatus = 'publish' | 'draft' | 'pending' | 'private' | 'trash' | 'inherit' | string;

export interface WxrPostMeta {
  key: string;
  value: string;
}

export interface WxrComment {
  id: number;
  author: string;
  authorEmail: string;
  authorUrl: string;
  authorIp: string;
  date: string;
  dateGmt: string;
  content: string;
  approved: boolean;
  type: string;  // '' | 'pingback' | 'trackback'
  parentId: number;
  userId: number;
}

export interface WxrChannelInfo {
  title: string;
  link: string;
  description: string;
  language: string;
  wxrVersion: string;
  baseSiteUrl: string;
  baseBlogUrl: string;
  authors: WxrAuthor[];
}

export interface WxrAuthor {
  login: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
}

export interface WxrCategory {
  termId: number;
  slug: string;
  parent: string;
  name: string;
}

export interface WxrTag {
  termId: number;
  slug: string;
  name: string;
}

export interface WxrResult {
  items: WxrItem[];
  channelInfo: WxrChannelInfo;
  categories: WxrCategory[];
  tags: WxrTag[];
}

// ── Parsing options ─────────────────────────────────────────────────────

export interface WxrParseOptions {
  /** Which post types to include. Defaults to ['post', 'page']. */
  includePostTypes?: WxrPostType[];
  /** Whether to include attachments. Defaults to false. */
  includeAttachments?: boolean;
  /** Whether to include revisions. Defaults to false. */
  includeRevisions?: boolean;
  /** Whether to parse comments. Defaults to false. */
  parseComments?: boolean;
  /** Whether to parse postmeta. Defaults to true. */
  parsePostMeta?: boolean;
}

const DEFAULT_OPTIONS: WxrParseOptions = {
  includePostTypes: ['post', 'page'],
  includeAttachments: false,
  includeRevisions: false,
  parseComments: false,
  parsePostMeta: true,
};

// ── Main parser ─────────────────────────────────────────────────────────

export function parseWxr(xmlContent: string, opts: WxrParseOptions = {}): WxrResult {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    htmlEntities: true,
  });

  const parsed = parser.parse(xmlContent) as Record<string, any>;

  // Navigate to the RSS channel
  const rss = parsed.rss || parsed;
  const channel = rss.channel || rss;

  // Parse channel metadata
  const channelInfo: WxrChannelInfo = {
    title: String(channel.title || ''),
    link: String(channel.link || ''),
    description: String(channel.description || ''),
    language: String(channel.language || ''),
    wxrVersion: String(channel['wp:wxr_version'] || ''),
    baseSiteUrl: String(channel['wp:base_site_url'] || ''),
    baseBlogUrl: String(channel['wp:base_blog_url'] || ''),
    authors: parseAuthors(channel),
  };

  // Parse top-level categories and tags
  const categories = parseTopLevelCategories(channel);
  const tags = parseTopLevelTags(channel);

  // Parse items
  const items: WxrItem[] = [];
  const rawItems = ensureArray(channel.item || []) as Record<string, any>[];

  const allowedTypes = new Set(options.includePostTypes);
  if (options.includeAttachments) allowedTypes.add('attachment');
  if (options.includeRevisions) allowedTypes.add('revision');

  for (const raw of rawItems) {
    const postType = String(raw['wp:post_type'] || 'post');

    if (!allowedTypes.has(postType)) continue;

    // Extract categories and tags from <category> elements
    const rawCategories = ensureArray(raw.category || []) as Record<string, any>[];
    const tagsArr: string[] = [];
    const categoriesArr: string[] = [];

    for (const cat of rawCategories) {
      if (typeof cat === 'object' && cat !== null && cat['@_domain']) {
        const domain = String(cat['@_domain']);
        const name = String(cat['#text'] || cat['@_nicename'] || '');
        if (domain === 'post_tag' && name) tagsArr.push(name);
        else if (domain === 'category' && name) categoriesArr.push(name);
      } else if (typeof cat === 'string') {
        categoriesArr.push(String(cat));
      }
    }

    items.push({
      title: String(raw.title || ''),
      postName: String(raw['wp:post_name'] || ''),
      postType: postType as WxrPostType,
      content: String(raw['content:encoded'] || raw['content_encoded'] || ''),
      excerpt: String(raw['excerpt:encoded'] || raw['excerpt_encoded'] || ''),
      pubDate: String(raw.pubDate || ''),
      postDate: String(raw['wp:post_date'] || ''),
      postDateGmt: String(raw['wp:post_date_gmt'] || ''),
      status: String(raw['wp:status'] || 'publish') as WxrStatus,
      tags: [...new Set(tagsArr)],
      categories: [...new Set(categoriesArr)],
      creator: String(raw['dc:creator'] || raw['dc:Creator'] || ''),
      link: String(raw.link || ''),
      postId: Number(raw['wp:post_id'] || 0),
      postParent: Number(raw['wp:post_parent'] || 0),
      attachmentUrl: String(raw['wp:attachment_url'] || ''),
      postPassword: String(raw['wp:post_password'] || ''),
      isSticky: Number(raw['wp:is_sticky'] || 0) === 1,
      postMeta: options.parsePostMeta ? parsePostMeta(raw) : [],
      comments: options.parseComments ? parseComments(raw) : [],
    });
  }

  return { items, channelInfo, categories, tags };
}

// ── Channel-level parsing ───────────────────────────────────────────────

function parseAuthors(channel: Record<string, any>): WxrAuthor[] {
  const raw = ensureArray(channel['wp:author'] || []) as Record<string, any>[];
  return raw.map((a) => ({
    login: String(a['wp:author_login'] || ''),
    email: String(a['wp:author_email'] || ''),
    displayName: String(a['wp:author_display_name'] || ''),
    firstName: String(a['wp:author_first_name'] || ''),
    lastName: String(a['wp:author_last_name'] || ''),
  }));
}

function parseTopLevelCategories(channel: Record<string, any>): WxrCategory[] {
  const raw = ensureArray(channel['wp:category'] || []) as Record<string, any>[];
  return raw.map((c) => ({
    termId: Number(c['wp:term_id'] || 0),
    slug: String(c['wp:category_nicename'] || ''),
    parent: String(c['wp:category_parent'] || ''),
    name: String(c['wp:cat_name'] || ''),
  }));
}

function parseTopLevelTags(channel: Record<string, any>): WxrTag[] {
  const raw = ensureArray(channel['wp:tag'] || []) as Record<string, any>[];
  return raw.map((t) => ({
    termId: Number(t['wp:term_id'] || 0),
    slug: String(t['wp:tag_slug'] || ''),
    name: String(t['wp:tag_name'] || ''),
  }));
}

// ── Item-level parsing ──────────────────────────────────────────────────

function parsePostMeta(raw: Record<string, any>): WxrPostMeta[] {
  const metas = ensureArray(raw['wp:postmeta'] || []) as Record<string, any>[];
  return metas.map((m) => ({
    key: String(m['wp:meta_key'] || ''),
    value: String(m['wp:meta_value'] || ''),
  }));
}

function parseComments(raw: Record<string, any>): WxrComment[] {
  const rawComments = ensureArray(raw['wp:comment'] || []) as Record<string, any>[];
  return rawComments.map((c) => ({
    id: Number(c['wp:comment_id'] || 0),
    author: String(c['wp:comment_author'] || ''),
    authorEmail: String(c['wp:comment_author_email'] || ''),
    authorUrl: String(c['wp:comment_author_url'] || ''),
    authorIp: String(c['wp:comment_author_IP'] || ''),
    date: String(c['wp:comment_date'] || ''),
    dateGmt: String(c['wp:comment_date_gmt'] || ''),
    content: String(c['wp:comment_content'] || ''),
    approved: String(c['wp:comment_approved'] || '') === '1',
    type: String(c['wp:comment_type'] || ''),
    parentId: Number(c['wp:comment_parent'] || 0),
    userId: Number(c['wp:comment_user_id'] || 0),
  }));
}

// ── Slug helper (shared) ────────────────────────────────────────────────

export function wxrSlugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function wxrDeriveSlug(item: WxrItem): string {
  if (item.postName) return item.postName;
  return wxrSlugify(item.title);
}
