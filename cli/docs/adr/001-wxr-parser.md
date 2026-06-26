# ADR-001: Shared WXR parser for Squarespace + WordPress routes

## Status

Accepted

## Context

Squarespace exports site content as a WordPress eXtended RSS (WXR) XML file. This is the same format that WordPress itself uses for its built-in export tool. Both Squarespace and WordPress WXR files share the same XML structure:

- `<channel>` with `<title>`, `<link>`, `<description>`, `<wp:wxr_version>`, `<wp:author>`, `<wp:category>`, `<wp:tag>`
- `<item>` with `<title>`, `<link>`, `<pubDate>`, `<dc:creator>`, `<content:encoded>`, `<excerpt:encoded>`, `<wp:post_id>`, `<wp:post_date>`, `<wp:post_name>`, `<wp:status>`, `<wp:post_type>`, `<category domain="post_tag|category">`, `<wp:postmeta>`, `<wp:comment>`, `<wp:attachment_url>`

The overlapping core is approximately 80% of the parsing logic. The platform-specific differences are:

| Concern | Squarespace | WordPress |
|---------|-------------|-----------|
| HTML wrappers | `sqs-block` divs, inline styles | Clean HTML or shortcodes |
| Image hosting | CDN at `images.squarespace-cdn.com` | `wp:attachment_url` + local uploads |
| Comments | Rarely present | Full `wp:comment` sections |
| Post meta | Minimal | Rich `wp:postmeta` with custom fields |
| URL patterns | `/blog/slug` | Permalink settings with date/category patterns |
| Authors | `dc:creator` only | Full `wp:author` sections in channel |

## Decision

Extract WXR XML parsing into a shared `wxr-parser.ts` library that both `squarespace.ts` and a future `wordpress.ts` can import. The shared parser:

1. Parses all WXR fields (post, page, attachment, revision, nav_menu_item types)
2. Extracts channel-level metadata (authors, categories, tags, base URLs)
3. Parses `wp:postmeta` and `wp:comment` sections (off by default, opt-in via `WxrParseOptions`)
4. Returns a rich `WxrResult` with typed `WxrItem[]`, `WxrChannelInfo`, `WxrCategory[]`, `WxrTag[]`
5. Provides `wxrSlugify()` and `wxrDeriveSlug()` shared helpers

Platform-specific concerns remain in their respective files:
- `squarespace.ts` owns `sqs-block` stripping, CDN image extraction/download, hero derivation, feature mapping
- `wordpress.ts` (future) will own shortcode parsing, permalink pattern resolution, attachment handling

## Consequences

**Positive:**
- A future wordpress2astro route gets 80% of parsing for free
- Single source of truth for WXR format handling
- The shared parser's `WxrParseOptions` allows each platform to opt in/out of features (comments, postmeta, attachments) without code duplication
- Bug fixes to the XML parser benefit all WXR-based routes

**Negative:**
- The `WxrItem` type is broader than Squarespace needs (e.g., `comments[]`, `postMeta[]` are always empty for Squarespace exports). This is a minor overhead.
- Changes to the parser interface must consider both platforms. However, the `WxrParseOptions` defaults are conservative (comments off, attachments off) so Squarespace behavior doesn't change.

## CDN Image Accessibility

Squarespace CDN images at `images.squarespace-cdn.com` are public static URLs. No authentication is required to download them. Key details:

- URL format: `https://images.squarespace-cdn.com/content/<site_id>/<image_id>/<filename>?format=<variant>`
- Available variants: 100w, 300w, 500w, 750w, 1000w, 1500w, 2500w (no "original" parameter; 2500w is maximum)
- After site deletion, images persist on CDN for 8-38 days
- The `?format=` query parameter controls size; stripping it returns a default size

The `downloadCdnImage()` function in `squarespace.ts` implements the download+rehost strategy:
1. Strip `?format=` from URLs found in the WXR
2. Re-request with `?format=2500w` for maximum available quality
3. Save to `src/assets/blog/<filename>`
4. Rewrite body image references from CDN URLs to relative paths
5. Report any download failures (image may have expired from CDN)
