/**
 * Shared configuration parsing and validation. Reads config.yaml if present,
 * validates required CLI flags per platform, and provides a typed config object.
 *
 * This is part of the portage-core shared pipeline.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────

export interface PortageConfig {
  source: {
    platform: string;
    path?: string;
    exportFile?: string;
    url?: string;
  };
  destination: {
    platform: string;
    method: string;
  };
  options: {
    includeDrafts: boolean;
    dryRun: boolean;
    heroStrategy: 'first-image' | 'none';
    idStrategy: 'prefix' | 'original';
    permalinkStyle: 'flat' | 'original' | 'preserve';
    router: 'pages' | 'app';
    imageStrategy: 'assets' | 'public' | 'localize-external';
    redirectFormat: 'netlify' | 'vercel' | 'astro';
  };
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ── Required fields per platform ─────────────────────────────────────────

const PLATFORM_REQUIREMENTS: Record<string, { exportRequired: boolean; sourceRequired: boolean; urlOptional?: boolean }> = {
  gatsby:       { exportRequired: false, sourceRequired: true },
  ghost:        { exportRequired: true,  sourceRequired: false, urlOptional: true },
  jekyll:       { exportRequired: false, sourceRequired: true },
  squarespace:  { exportRequired: true,  sourceRequired: false },
  substack:     { exportRequired: true,  sourceRequired: false, urlOptional: true },
  next:         { exportRequired: false, sourceRequired: true },
};

// ── Validation ─────────────────────────────────────────────────────────

export function validateConfig(
  platform: string,
  sourceDir?: string,
  exportFile?: string,
): ValidationResult {
  const errors: ValidationError[] = [];
  const reqs = PLATFORM_REQUIREMENTS[platform];

  if (!reqs) {
    errors.push({ field: 'platform', message: `Unsupported platform: ${platform}. Supported: ${Object.keys(PLATFORM_REQUIREMENTS).join(', ')}` });
    return { valid: false, errors };
  }

  if (reqs.exportRequired && !exportFile) {
    errors.push({ field: 'export', message: `${platform} requires --export <path> pointing to the export file` });
  }

  if (reqs.exportRequired && exportFile && !existsSync(resolve(exportFile))) {
    errors.push({ field: 'export', message: `Export file not found: ${exportFile}` });
  }

  if (reqs.sourceRequired && !sourceDir) {
    errors.push({ field: 'source', message: `${platform} requires --source <dir> pointing to the project directory` });
  }

  return { valid: errors.length === 0, errors };
}

// ── Config.yaml Reader ──────────────────────────────────────────────────

export function readConfigYaml(configPath: string): Record<string, unknown> | null {
  const path = resolve(configPath);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, 'utf-8');
  // Minimal YAML parsing for flat key: value pairs
  const config: Record<string, unknown> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = trimmed.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      const [, key, val] = kv;
      config[key] = parseYamlValue(val);
    }
  }
  return config;
}

function parseYamlValue(val: string): unknown {
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (/^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^\[.*\]$/.test(trimmed)) {
    try { return JSON.parse(trimmed.replace(/'/g, '"')); } catch { return trimmed; }
  }
  return trimmed;
}

// ── Supported platforms ─────────────────────────────────────────────────

export const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_REQUIREMENTS);
export const SUPPORTED_DESTINATIONS = ['astro', 'payload', 'sanity'] as const;
export type Destination = typeof SUPPORTED_DESTINATIONS[number];
