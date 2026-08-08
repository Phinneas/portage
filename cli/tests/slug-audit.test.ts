import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditRedirects,
  toNginx,
  toCaddy,
  toRedirectsFile,
  formatRules,
  writeAuditFiles,
  loadReport,
} from '../src/slug-audit.js';
import type { MigrationReport } from '../src/report.js';

function sampleReport(): MigrationReport {
  return {
    version: '1.0',
    generated_by: 'portage@0.1.0',
    generated_at: '2026-08-08T20:00:00.000Z',
    destination_base_url: 'https://example.com',
    destination_platform: 'astro',
    records: [
      {
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/blog/storytelling-copywriter',
        destination_path: '/blog/storytelling-copywriter/',
        status: 'migrated',
        images_rehosted: true,
        links_rewritten: true,
      },
      {
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/blog/nonprofit-registration',
        destination_path: '/blog/nonprofit-registration/',
        status: 'migrated',
        images_rehosted: true,
        links_rewritten: true,
      },
      {
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/about/team',
        destination_path: '/about/',
        status: 'redirected',
        redirect_target: 'https://example.com/about/',
        images_rehosted: true,
        links_rewritten: true,
      },
      {
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/blog/2021/01/draft-post',
        destination_path: null,
        status: 'excluded',
        reason: 'draft',
        images_rehosted: false,
        links_rewritten: false,
      },
      {
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/blog/kept-path',
        destination_path: '/blog/kept-path/',
        status: 'migrated',
        images_rehosted: true,
        links_rewritten: true,
      },
      {
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/blog/broken-item',
        destination_path: null,
        status: 'failed',
        reason: 'transform error',
        images_rehosted: false,
        links_rewritten: false,
      },
    ],
  };
}

describe('slug-audit', () => {
  describe('auditRedirects', () => {
    it('turns migrated/redirected records into 301 rules', () => {
      const rules = auditRedirects(sampleReport());
      const sources = rules.map((r) => r.source);
      expect(sources).toContain('/blog/storytelling-copywriter');
      expect(sources).toContain('/blog/nonprofit-registration');
      // redirected: target from destination_path
      const team = rules.find((r) => r.source === '/about/team');
      expect(team?.target).toBe('/about/');
      expect(team?.status).toBe(301);
    });

    it('skips records whose source and destination paths are identical', () => {
      const rules = auditRedirects(sampleReport());
      expect(rules.some((r) => r.source === '/blog/kept-path/')).toBe(false);
    });

    it('emits 410 rules for excluded/quarantined only with --gone', () => {
      expect(auditRedirects(sampleReport()).some((r) => r.status === 410)).toBe(false);
      const rules = auditRedirects(sampleReport(), { gone: true });
      const gone = rules.find((r) => r.status === 410);
      expect(gone?.source).toBe('/blog/2021/01/draft-post');
      expect(gone?.target).toBeNull();
    });

    it('never emits rules for failed records', () => {
      const rules = auditRedirects(sampleReport(), { gone: true });
      expect(rules.some((r) => r.source === '/blog/broken-item')).toBe(false);
    });

    it('sorts rules by source path and dedupes', () => {
      const report = sampleReport();
      report.records.push({
        source_platform: 'squarespace',
        source_url: 'https://oldsite.com/blog/nonprofit-registration',
        destination_path: '/blog/nonprofit-registration/',
        status: 'migrated',
        images_rehosted: true,
        links_rewritten: true,
      });
      const rules = auditRedirects(report);
      expect(rules.filter((r) => r.source === '/blog/nonprofit-registration')).toHaveLength(1);
      const sources = rules.map((r) => r.source);
      expect([...sources].sort()).toEqual(sources);
    });

    it('extracts the path from URLs with query strings', () => {
      const report = sampleReport();
      report.records[0].source_url = 'https://oldsite.com/blog/storytelling-copywriter?utm_source=newsletter';
      const rules = auditRedirects(report);
      expect(rules.find((r) => r.source === '/blog/storytelling-copywriter')).toBeDefined();
    });
  });

  describe('toNginx', () => {
    it('emits exact-match location blocks', () => {
      const rules = auditRedirects(sampleReport(), { gone: true });
      const out = toNginx(rules);
      expect(out).toContain('location = /blog/storytelling-copywriter { return 301 /blog/storytelling-copywriter/; }');
      expect(out).toContain('location = /blog/2021/01/draft-post { return 410; }');
      expect(out).toMatch(/^# Generated by portage slug-audit/);
    });
  });

  describe('toCaddy', () => {
    it('emits redir and respond directives', () => {
      const rules = auditRedirects(sampleReport(), { gone: true });
      const out = toCaddy(rules);
      expect(out).toContain('redir /blog/storytelling-copywriter /blog/storytelling-copywriter/ permanent');
      expect(out).toContain('respond /blog/2021/01/draft-post 410');
      expect(out).toContain('# Import with: import Caddyfile.redirects');
    });
  });

  describe('toRedirectsFile / formatRules', () => {
    it('emits Netlify/Cloudflare-compatible lines', () => {
      const rules = auditRedirects(sampleReport(), { gone: true });
      const out = toRedirectsFile(rules);
      expect(out).toContain('/blog/storytelling-copywriter  /blog/storytelling-copywriter/  301');
      expect(out).toContain('/blog/2021/01/draft-post  410');
    });

    it('produces identical content for netlify and cloudflare', () => {
      const rules = auditRedirects(sampleReport());
      expect(formatRules(rules, 'netlify')).toBe(formatRules(rules, 'cloudflare'));
    });

    it('percent-encodes spaces in paths', () => {
      const report = sampleReport();
      report.records[0].source_url = 'https://oldsite.com/blog/hello world';
      report.records[0].destination_path = '/blog/hello%20world/';
      const out = toRedirectsFile(auditRedirects(report));
      expect(out).toContain('/blog/hello%20world');
    });
  });

  describe('writeAuditFiles', () => {
    const tmpDir = resolve(__dirname, 'fixtures', 'slug-audit-tmp-test');

    it('writes the requested formats; netlify+cloudflare share one file', () => {
      mkdirSync(tmpDir, { recursive: true });
      const rules = auditRedirects(sampleReport());
      const files = writeAuditFiles(rules, tmpDir, ['nginx', 'caddy', 'netlify', 'cloudflare']);
      expect(files).toHaveLength(3);
      expect(files.map((f) => f.format)).toEqual(['nginx', 'caddy', 'netlify']);
      expect(existsSync(resolve(tmpDir, 'nginx-redirects.conf'))).toBe(true);
      expect(existsSync(resolve(tmpDir, 'Caddyfile.redirects'))).toBe(true);
      expect(existsSync(resolve(tmpDir, '_redirects'))).toBe(true);
      const content = readFileSync(resolve(tmpDir, '_redirects'), 'utf-8');
      expect(content).toContain('/blog/storytelling-copywriter');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('loadReport', () => {
    const tmpDir = resolve(__dirname, 'fixtures', 'slug-audit-load-tmp');

    it('loads and validates a v1.0 report', () => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(resolve(tmpDir, 'migration-report.json'), JSON.stringify(sampleReport()), 'utf-8');
      const report = loadReport(resolve(tmpDir, 'migration-report.json'));
      expect(report.version).toBe('1.0');
      expect(report.records).toHaveLength(6);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects a non-conforming report', () => {
      mkdirSync(tmpDir, { recursive: true });
      const bad = { ...sampleReport(), version: '0.9' };
      writeFileSync(resolve(tmpDir, 'migration-report.json'), JSON.stringify(bad), 'utf-8');
      expect(() => loadReport(resolve(tmpDir, 'migration-report.json'))).toThrow();
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
