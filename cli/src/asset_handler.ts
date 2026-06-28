/**
 * Shared asset handler. Downloads remote images, computes content hashes,
 * and rewrites URL references. Unified from the duplicated download logic
 * previously in squarespace.ts, substack.ts, payload-writer.ts, and
 * sanity-writer.ts.
 *
 * This is part of the portage-core shared pipeline.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { Manifest } from './manifest.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface DownloadResult {
  success: boolean;
  localPath: string;
  error?: string;
}

export interface BatchDownloadResult {
  downloaded: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export type ImageSubdir = 'src/assets/blog' | 'media' | 'import/assets' | 'src/assets';

export interface DownloadOptions {
  /** URL to download */
  url: string;
  /** Base target directory */
  targetDir: string;
  /** Subdirectory within targetDir for image placement */
  subdir: ImageSubdir;
  /** Transform URL before download (e.g. add ?format=2500w for Squarespace) */
  urlTransform?: (url: string) => string;
  /** Transform URL for filename derivation (strip query params, etc.) */
  filenameTransform?: (url: string) => string;
}

// ── Content Checksum ────────────────────────────────────────────────────

export function checksumString(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// ── Single Image Download ───────────────────────────────────────────────

export async function downloadImage(opts: DownloadOptions): Promise<DownloadResult> {
  const urlForFilename = opts.filenameTransform ? opts.filenameTransform(opts.url) : opts.url;
  const filename = basename(new URL(urlForFilename).pathname);
  const fullSubdir = resolve(opts.targetDir, opts.subdir);
  const localPath = resolve(fullSubdir, filename);

  if (existsSync(localPath)) {
    return { success: true, localPath };
  }

  const downloadUrl = opts.urlTransform ? opts.urlTransform(opts.url) : opts.url;

  try {
    mkdirSync(fullSubdir, { recursive: true });

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      return { success: false, localPath, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(localPath, buffer);
    return { success: true, localPath };
  } catch (err) {
    return { success: false, localPath, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Batch Download from Manifest ────────────────────────────────────────

export async function downloadAllRemoteImages(
  manifest: Manifest,
  targetDir: string,
  dryRun: boolean,
  subdir: ImageSubdir,
  urlTransform?: (url: string) => string,
  filenameTransform?: (url: string) => string,
): Promise<BatchDownloadResult> {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const img of manifest.extract.images) {
    if (img.source !== 'remote') { skipped++; continue; }
    if (dryRun) { skipped++; continue; }

    const result = await downloadImage({
      url: img.absolutePath,
      targetDir,
      subdir,
      urlTransform,
      filenameTransform,
    });

    if (result.success) downloaded++;
    else { failed++; if (result.error) errors.push(`${img.relativePath}: ${result.error}`); }
  }

  return { downloaded, skipped, failed, errors };
}

// ── Platform-Specific URL Transforms ─────────────────────────────────────

/** Squarespace CDN: request at highest quality (2500w is max) */
export function sqspUrlTransform(url: string): string {
  return url.includes('?format=') ? url.replace(/\?format=\w+$/, '?format=2500w') : url + '?format=2500w';
}

/** Squarespace CDN: strip format query for filename */
export function sqspFilenameTransform(url: string): string {
  return url.replace(/\?format=\w+$/, '');
}

/** Ghost CDN: strip size variants for original */
export function ghostUrlTransform(url: string): string {
  return url.replace(/\/size\/w\d+\//, '/content/images/');
}

/** Ghost CDN: strip format query for filename */
export function ghostFilenameTransform(url: string): string {
  return url.replace(/\/size\/w\d+\//, '/content/images/').replace(/\?format=\w+$/, '');
}

/** Substack CDN: strip resize params for original quality */
export function substackUrlTransform(url: string): string {
  return url.replace(/[?&]format=\w+/, '').replace(/[?&]w=\d+/, '');
}

/** Substack CDN: strip query for filename */
export function substackFilenameTransform(url: string): string {
  return url.replace(/\?.*$/, '');
}
