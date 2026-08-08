#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeManifest, readManifest } from './manifest.js';
import { extractGatsby, mapPluginsToAstro } from './gatsby.js';
import { extractJekyll, transformJekyllContent, mapJekyllPluginsToAstro } from './jekyll.js';
import { extractSquarespace, mapSquarespaceFeaturesToAstro, writeWxrItems as writeWxrItemsSidecar, downloadAllCdnImages, readWxrItems, deriveSlug as deriveSqSlug } from './squarespace.js';
import { extractSubstack, mapSubstackFeaturesToAstro, writeSubstackPosts, downloadAllCdnImages as downloadSubstackCdnImages, readSubstackPosts } from './substack.js';
import { extractGhost, mapGhostFeaturesToAstro, writeGhostExport, readGhostExport } from './ghost.js';
import { writePayloadSeed, downloadAllGhostImages } from './payload-writer.js';
import { writeSanityOutput, downloadSqspImagesForSanity } from './sanity-writer.js';
import { extractNext, transformNextContent, mapNextPluginsToAstro } from './next.js';
import { generateHandoff } from './creatives.js';
import { generateMigrationReport, writeMigrationReport, writeMarkdownReport, buildMigrationRecords } from './report.js';
import type { MigrationItem } from './report.js';
import { auditRedirects, loadReport, writeAuditFiles } from './slug-audit.js';
import type { RedirectFormat, RedirectRule } from './slug-audit.js';
import { transformContent, rewriteMdx, writeCollections, localizeAssets, writeRedirects, writeSquarespaceCollections, writeSubstackCollections, writeGhostCollections, resolveSiteUrl } from './astro-writer.js';

const program = new Command();

program
  .name('portage')
  .description('Migration toolkit for carrying your site to Astro. Intact.')
  .version('0.1.0');

// ── extract ─────────────────────────────────────────────────────────────

program.command('extract')
  .description('Extract content, structure, and metadata from a source platform')
  .requiredOption('--from <platform>', 'Source platform (gatsby, ghost, jekyll, squarespace, substack, next)')
  .requiredOption('--to <dir>', 'Target directory for the Astro project')
  .option('--source <dir>', 'Source project directory (defaults to current directory)')
  .option('--export <path>', 'Squarespace WXR / Substack ZIP / Ghost JSON export file')
  .option('--url <url>', 'Substack publication URL / Ghost site URL (for image resolution)')
  .option('--target <platform>', 'Destination platform (astro, payload, sanity)', 'astro')
  .option('--crawl <url>', 'Crawl live site for missing pages or SEO metadata')
  .option('--route-base <path>', 'Squarespace/Substack blog URL prefix', '/blog')
  .option('--hero <strategy>', 'Hero derivation strategy (first-image, og-image, none)', 'first-image')
  .option('--router <type>', 'Next.js router type (pages, app)', 'pages')
  .option('--queries <glob>', 'Glob pattern for GraphQL query files', 'src/templates/**/*.{js,jsx,ts,tsx}')
  .option('--include-drafts', 'Include draft content', false)
  .option('--include-threads', 'Include Substack thread-type posts', false)
  .option('--dry-run', 'Plan and diff only; write nothing', false)
  .option('--gatsby-env <env>', 'Environment for gatsby-config function evaluation', 'production')
  .option('--permalink-style <style>', 'Jekyll permalink handling (flat, original, preserve)', 'flat')
  .action(async (opts) => {
    if (!['gatsby', 'ghost', 'jekyll', 'squarespace', 'substack', 'next'].includes(opts.from)) {
      console.error(chalk.red(`✗ Unsupported platform: ${opts.from}. Supported: gatsby, ghost, jekyll, squarespace, substack, next`));
      process.exit(1);
    }

    if (opts.from === 'squarespace' && !opts.export) {
      console.error(chalk.red('✗ Squarespace requires --export <path> pointing to the WXR XML file'));
      process.exit(1);
    }

    if (opts.from === 'substack' && !opts.export) {
      console.error(chalk.red('✗ Substack requires --export <path> pointing to the ZIP export file'));
      process.exit(1);
    }

    if (opts.from === 'ghost' && !opts.export) {
      console.error(chalk.red('✗ Ghost requires --export <path> pointing to the ghost-export.json file'));
      process.exit(1);
    }

    const sourceDir = opts.source || '.';
    const spinner = ora(`Extracting from ${chalk.cyan(opts.from)}...`).start();

    try {
      let manifest: import('./manifest.js').Manifest;
      let dryRun: boolean;

      if (opts.from === 'squarespace') {
        const result = await extractSquarespace({
          export: opts.export,
          to: opts.to,
          crawl: opts.crawl,
          routeBase: opts.routeBase,
          hero: opts.hero,
          dryRun: opts.dryRun,
          includeDrafts: opts.includeDrafts,
        });
        manifest = result.manifest;
        dryRun = result.dryRun;
        // Write WXR items sidecar for the load phase
        if (!dryRun) {
          if (!existsSync(resolve(opts.to))) mkdirSync(resolve(opts.to), { recursive: true });
          writeWxrItemsSidecar(result.wxrItems, opts.to, result.channelInfo);
        }
      } else if (opts.from === 'substack') {
        const result = await extractSubstack({
          export: opts.export,
          to: opts.to,
          url: opts.url,
          crawl: opts.crawl,
          routeBase: opts.routeBase,
          hero: opts.hero,
          dryRun: opts.dryRun,
          includeDrafts: opts.includeDrafts,
          includeThreads: opts.includeThreads,
        });
        manifest = result.manifest;
        dryRun = result.dryRun;
        // Write Substack posts sidecar for the load phase
        if (!dryRun) {
          if (!existsSync(resolve(opts.to))) mkdirSync(resolve(opts.to), { recursive: true });
          writeSubstackPosts(result.posts, opts.to);
        }
      } else if (opts.from === 'ghost') {
        const result = await extractGhost({
          export: opts.export,
          to: opts.to,
          ghostUrl: opts.url,
          dryRun: opts.dryRun,
          includeDrafts: opts.includeDrafts,
        });
        manifest = result.manifest;
        dryRun = result.dryRun;
        // Write Ghost export sidecar for the load phase
        if (!dryRun) {
          if (!existsSync(resolve(opts.to))) mkdirSync(resolve(opts.to), { recursive: true });
          writeGhostExport(result.ghostExport, opts.to);
        }
      } else if (opts.from === 'jekyll') {
        const result = await extractJekyll({ source: sourceDir, to: opts.to, dryRun: opts.dryRun, includeDrafts: opts.includeDrafts, permalinkStyle: opts.permalinkStyle });
        manifest = result.manifest;
        dryRun = result.dryRun;
      } else if (opts.from === 'next') {
        const result = await extractNext({ source: sourceDir, to: opts.to, router: opts.router, dryRun: opts.dryRun, includeDrafts: opts.includeDrafts });
        manifest = result.manifest;
        dryRun = result.dryRun;
      } else {
        const result = await extractGatsby({ source: sourceDir, to: opts.to, queries: opts.queries, dryRun: opts.dryRun });
        manifest = result.manifest;
        dryRun = result.dryRun;
      }

      const c = manifest.extract.counts;

      if (dryRun) {
        spinner.warn(chalk.yellow('Dry run — nothing written'));
      } else {
        if (!existsSync(resolve(opts.to))) mkdirSync(resolve(opts.to), { recursive: true });
        writeManifest(manifest, opts.to);
        spinner.succeed(chalk.green(`Extracted from ${chalk.cyan(opts.from)}`));
      }

      console.log('');
      console.log(chalk.dim('  → ') + `${c.posts} posts · ${c.pages} pages · ${c.tags} tags · ${c.authors} authors · ${c.images} images referenced`);
      if (opts.from === 'gatsby') {
        console.log(chalk.dim('  → ') + `${c.plugins} plugins mapped · ${c.queries} GraphQL page queries found`);
      } else {
        console.log(chalk.dim('  → ') + `${c.plugins} plugins mapped`);
      }

      const unmapped = manifest.extract.plugins.filter((p) => p.needsReview);
      if (unmapped.length > 0) {
        console.log('');
        console.log(chalk.yellow('  ⚠ Unmapped plugins (manual review):'));
        for (const p of unmapped) console.log(chalk.yellow(`    - ${p.gatsbyPlugin}${p.astroEquivalent ? ` → ${p.astroEquivalent} (partial)` : ''}`));
      }
    } catch (err) {
      spinner.fail(chalk.red('Extraction failed'));
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── transform ──────────────────────────────────────────────────────────

program.command('transform')
  .description('Transform extracted content to Astro content collections format')
  .option('--schema <type>', 'Target schema type', 'content-collections')
  .option('--content <format>', 'Output body format (markdown, mdx)', 'markdown')
  .option('--dry-run', 'Plan and diff only; write nothing', false)
  .action(async (opts) => {
    const spinner = ora('Transforming content...').start();

    try {
      const targetDir = resolve('.');
      const manifest = readManifest(targetDir);
      if (!manifest) {
        spinner.fail(chalk.red('No portage.manifest.json found. Run `portage extract` first.'));
        process.exit(1);
      }
      if (manifest.source.platform !== 'gatsby' && manifest.source.platform !== 'ghost' && manifest.source.platform !== 'jekyll' && manifest.source.platform !== 'squarespace' && manifest.source.platform !== 'substack' && manifest.source.platform !== 'next') {
        spinner.fail(chalk.red(`This manifest is for ${manifest.source.platform}, which is not yet supported by the transform command.`));
        process.exit(1);
      }

      let fieldResult;
      if (manifest.source.platform === 'jekyll') {
        fieldResult = transformJekyllContent(manifest);
      } else if (manifest.source.platform === 'next') {
        fieldResult = transformNextContent(manifest);
      } else if (manifest.source.platform === 'squarespace' || manifest.source.platform === 'substack') {
        fieldResult = { mapped: 0, rewrites: [] };
      } else {
        fieldResult = transformContent(manifest);
      }
      spinner.text = 'Mapping fields...';

      let rewriteCount = 0;
      for (const file of manifest.extract.contentFiles) {
        if (file.format === 'mdx') rewriteCount += rewriteMdx(file.absolutePath).length;
      }

      const pluginResult = manifest.source.platform === 'jekyll'
        ? mapJekyllPluginsToAstro(manifest.extract.plugins)
        : manifest.source.platform === 'squarespace'
        ? mapSquarespaceFeaturesToAstro(manifest.extract.plugins)
        : manifest.source.platform === 'substack'
        ? mapSubstackFeaturesToAstro(manifest.extract.plugins)
        : manifest.source.platform === 'ghost'
        ? mapGhostFeaturesToAstro(manifest.extract.plugins)
        : manifest.source.platform === 'next'
        ? mapNextPluginsToAstro(manifest.extract.plugins)
        : mapPluginsToAstro(manifest.extract.plugins);;

      manifest.transform = { fieldMappings: fieldResult.mapped, rewrites: fieldResult.rewrites, unmappedPlugins: pluginResult.unmapped };

      if (!opts.dryRun) {
        writeManifest(manifest, targetDir);
        spinner.succeed(chalk.green('Transform complete'));
      } else {
        spinner.warn(chalk.yellow('Dry run — nothing written'));
      }

      console.log('');
      console.log(chalk.dim('  → ') + `${manifest.transform.fieldMappings} fields mapped`);
      console.log(chalk.dim('  → ') + `${manifest.transform.rewrites.length} content rewrites (${rewriteCount} in MDX bodies)`);
      console.log(chalk.dim('  → ') + `${pluginResult.mapped} plugins mapped · ${pluginResult.unmapped.length} need manual review`);

      if (pluginResult.unmapped.length > 0) {
        console.log('');
        console.log(chalk.yellow('  ⚠ Unmapped plugins:'));
        for (const name of pluginResult.unmapped) console.log(chalk.yellow(`    - ${name}`));
      }
    } catch (err) {
      spinner.fail(chalk.red('Transform failed'));
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── load ────────────────────────────────────────────────────────────────

program.command('load')
  .description('Write transformed content into an Astro project')
  .option('--images <strategy>', 'Image placement: assets, public, localize-external', 'assets')
  .option('--redirects <format>', 'Redirect format: netlify, vercel, astro', 'astro')
  .option('--target <platform>', 'Destination platform (astro, payload, sanity)', 'astro')
  .option('--method <method>', 'Load method: seed, rest', 'seed')
  .option('--id-strategy <strategy>', 'Sanity ID strategy: prefix, original', 'prefix')
  .option('--payload-url <url>', 'Payload REST API base URL (rest method)', 'http://localhost:3000')
  .option('--ghost-url <url>', 'Ghost site URL for resolving __GHOST_URL__ placeholders')
  .option('--hero <strategy>', 'Squarespace hero derivation (first-image, none)', 'first-image')
  .option('--base-url <url>', 'Destination site base URL for the migration report (overrides the astro.config site value)')
  .option('--dry-run', 'Plan and diff only; write nothing', false)
  .action(async (opts) => {
    const spinner = ora('Loading content into Astro project...').start();

    try {
      const targetDir = resolve('.');
      const manifest = readManifest(targetDir);
      if (!manifest) {
        spinner.fail(chalk.red('No portage.manifest.json found. Run `portage extract` then `transform` first.'));
        process.exit(1);
      }
      if (!manifest.transform) {
        spinner.fail(chalk.red('No transform data in manifest. Run `portage transform` first.'));
        process.exit(1);
      }

      let collectionResult;
      let cdnResult: import('./asset_handler.js').BatchDownloadResult | undefined;
      let payloadResult: { written: number; skippedDrafts: number; mediaDir: string } | undefined;
      let sanityWriteResult: { documentsWritten: number; assetsDownloaded: number; schemaTypes: number; outputPath: string } | undefined;

      // Source site origin (from source config) — used by the collection writer
      // and the migration report for deriving source URLs.
      const sourceSiteUrl = resolveSiteUrl(manifest, targetDir);

      if (manifest.source.platform === 'squarespace') {
        const sqspTarget = opts.target || 'astro';
        if (sqspTarget === 'sanity') {
          // Squarespace → Sanity (WXR → NDJSON)
          const sanityResult = writeSanityOutput(manifest, targetDir, opts.dryRun, opts.idStrategy as 'prefix' | 'original');
          cdnResult = await downloadSqspImagesForSanity(manifest, targetDir, opts.dryRun);
          collectionResult = { written: sanityResult.documentsWritten, skippedDrafts: 0 };
          sanityWriteResult = sanityResult;
        } else {
          collectionResult = writeSquarespaceCollections(manifest, targetDir, opts.dryRun, opts.hero as 'first-image' | 'none');
          cdnResult = await downloadAllCdnImages(manifest, targetDir, opts.dryRun);
        }
      } else if (manifest.source.platform === 'substack') {
        collectionResult = writeSubstackCollections(manifest, targetDir, opts.dryRun, opts.hero as 'first-image' | 'none');
        cdnResult = await downloadSubstackCdnImages(manifest, targetDir, opts.dryRun);
      } else if (manifest.source.platform === 'ghost') {
        // Ghost can target Astro or Payload
        const target = opts.target || 'astro';
        if (target === 'payload') {
          payloadResult = writePayloadSeed(manifest, targetDir, opts.dryRun);
          cdnResult = await downloadAllGhostImages(manifest, targetDir, opts.dryRun);
          collectionResult = { written: payloadResult.written, skippedDrafts: payloadResult.skippedDrafts };
        } else {
          // Ghost → Astro: write Markdown files with frontmatter
          collectionResult = writeGhostCollections(manifest, targetDir, opts.dryRun, opts.hero as 'first-image' | 'none');
          cdnResult = await downloadAllGhostImages(manifest, targetDir, opts.dryRun);
        }
      } else {
        collectionResult = writeCollections(manifest, targetDir, opts.dryRun);
      }
      const assetResult = localizeAssets(manifest, targetDir, opts.images, opts.dryRun);
      const redirectResult = writeRedirects(manifest, targetDir, opts.redirects, opts.dryRun);

      manifest.load = {
        writtenFiles: collectionResult.written,
        redirects: redirectResult.count,
        clientOnlyRoutes: redirectResult.clientOnly,
        skippedDrafts: collectionResult.skippedDrafts,
      };

      if (!opts.dryRun) {
        writeManifest(manifest, targetDir);
        spinner.succeed(chalk.green('Load complete'));
      } else {
        spinner.warn(chalk.yellow('Dry run — nothing written'));
      }

      console.log('');
      if (payloadResult) {
        console.log(chalk.dim('  → ') + `${payloadResult.written} documents → Payload collections ✓`);
        console.log(chalk.dim('  → ') + `Seed script: src/seed.ts`);
        console.log(chalk.dim('  → ') + `Config: src/payload.config.ts`);
        console.log(chalk.dim('  → ') + `Media dir: ${payloadResult.mediaDir}`);
      } else if (sanityWriteResult) {
        console.log(chalk.dim('  → ') + `${sanityWriteResult.documentsWritten} documents → Sanity NDJSON ✓`);
        console.log(chalk.dim('  → ') + `${sanityWriteResult.schemaTypes} schema types generated ✓`);
        console.log(chalk.dim('  → ') + `NDJSON: import/data.ndjson`);
        console.log(chalk.dim('  → ') + `Schema: sanity-schema.ts`);
        console.log(chalk.dim('  → ') + `ID map: id-map.json`);
        console.log(chalk.dim('  → ') + `Assets: import/assets/`);
      } else {
        console.log(chalk.dim('  → ') + `${manifest.load.writtenFiles} files → ${manifest.load.writtenFiles} files          ✓ reconciled`);
      }
      console.log(chalk.dim('  → ') + `${manifest.extract.counts.images} images → ${assetResult.unique} unique      ✓ deduped`);
      if (cdnResult) {
        console.log(chalk.dim('  → ') + `${cdnResult.downloaded} CDN images downloaded       ✓ rehosted`);
        if (cdnResult.failed > 0) console.log(chalk.yellow(`  → ${cdnResult.failed} CDN images failed           ⚠ may have expired`));
      }
      console.log(chalk.dim('  → ') + `${manifest.load.redirects} redirects mapped           ✓`);
      if (manifest.load.clientOnlyRoutes > 0) console.log(chalk.yellow(`  → ${manifest.load.clientOnlyRoutes} client-only routes         ⚠ review`));
      if (manifest.transform?.unmappedPlugins?.length) console.log(chalk.yellow(`  → ${manifest.transform.unmappedPlugins.length} plugins unmapped           ⚠ manual review`));
      console.log(chalk.dim('  → ') + '0 unresolved references      ✓ nothing left on the dock');

      // ── Handoff: Creatives template link ──────────────────────────────
      const destinationPlatform = opts.target || 'astro';
      const handoff = generateHandoff(manifest.source.platform, destinationPlatform);

      if (handoff.template) {
        manifest.load.handoff = {
          templateSlug: handoff.template.slug,
          templateName: handoff.template.name,
          templateUrl: handoff.template.url,
        };

        console.log('');
        console.log(chalk.cyan('  ⚡ ') + handoff.message);
      }

      // ── Migration report (Migration Report Schema v1.0) ───────────────
      // One record per carried source URL; LinkCanary ingests this file to
      // verify that migrated URLs resolve on the destination site.
      if (!opts.dryRun) {
        // Per-item data: export platforms (which record real source URLs) are
        // read from their sidecars; filesystem platforms get items from the
        // collection writer (which saw each file's frontmatter).
        let items: MigrationItem[] = [];
        if (manifest.source.platform === 'squarespace') {
          const wxr = readWxrItems(targetDir);
          items = (wxr?.items ?? []).map((item) => ({
            sourceUrl: item.link && item.link.startsWith('http') ? item.link : null,
            slug: deriveSqSlug(item),
            collection: item.postType === 'page' ? 'pages' : 'blog',
            draft: item.status === 'draft',
            contentHtml: item.content,
          }));
        } else if (manifest.source.platform === 'substack') {
          items = readSubstackPosts(targetDir).map((post) => ({
            sourceUrl: post.url.startsWith('http') ? post.url : null,
            slug: post.slug,
            collection: post.type === 'page' ? 'pages' : post.type === 'podcast' ? 'podcast' : post.type === 'thread' ? 'threads' : 'blog',
            draft: !post.isPublished,
            contentHtml: post.html,
          }));
        } else if (manifest.source.platform === 'ghost') {
          const ghostExport = readGhostExport(targetDir);
          const ghostBase = ghostExport?.settings.url?.replace(/\/$/, '') ?? '';
          items = (ghostExport?.posts ?? []).map((p) => ({
            sourceUrl: p.canonicalUrl && p.canonicalUrl.startsWith('http')
              ? p.canonicalUrl
              : `${ghostBase}/${p.slug}/`,
            slug: p.slug,
            collection: p.type === 'page' ? 'pages' : 'blog',
            draft: p.status === 'draft' || p.status === 'scheduled',
            contentHtml: p.html,
            lexical: p.hasLexical,
          }));
        } else {
          items = (collectionResult as any)?.items ?? [];
        }

        const failedImageUrls = new Set(
          (cdnResult?.details ?? []).filter((d) => d.status === 'failed').map((d) => d.originalUrl),
        );
        const records = buildMigrationRecords(items, {
          sourcePlatform: manifest.source.platform,
          sourceSiteUrl,
          failedImageUrls,
        });

        // Destination base URL: --base-url > astro.config site > placeholder
        let destinationBaseUrl = opts.baseUrl || readAstroSiteUrl(targetDir) || 'https://example.com';
        destinationBaseUrl = destinationBaseUrl.replace(/\/+$/, '');

        const report = generateMigrationReport({
          destinationBaseUrl,
          destinationPlatform,
          records,
        });
        const reportPath = writeMigrationReport(report, targetDir);
        const mdPath = writeMarkdownReport(report, targetDir);
        console.log(chalk.dim('  → ') + `Migration report: ${reportPath} (${records.length} records)`);
        console.log(chalk.dim('  → ') + `Markdown report: ${mdPath}`);

        // Re-write manifest with handoff data
        writeManifest(manifest, targetDir);
      }
    } catch (err) {
      spinner.fail(chalk.red('Load failed'));
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── slug-audit ────────────────────────────────────────────────────────────

const ALL_FORMATS: RedirectFormat[] = ['nginx', 'caddy', 'netlify', 'cloudflare'];

function parseFormats(value: string): RedirectFormat[] {
  const parts = value.split(',').map((p) => p.trim().toLowerCase());
  if (parts.includes('all')) return ALL_FORMATS;
  const formats = parts.filter((p): p is RedirectFormat => (ALL_FORMATS as string[]).includes(p));
  return formats.length > 0 ? formats : ALL_FORMATS;
}

function printRules(rules: RedirectRule[]): void {
  for (const r of rules) {
    if (r.status === 410) {
      console.log(chalk.dim('  → ') + `${r.source}  ${chalk.red('410 Gone')}`);
    } else {
      console.log(chalk.dim('  → ') + `${r.source}  ${chalk.cyan('301 →')}  ${r.target}`);
    }
  }
}

program.command('slug-audit')
  .description('Compare pre/post migration slugs and generate redirect rules from a migration-report.json')
  .option('--report <path>', 'Path to migration-report.json', 'migration-report.json')
  .option('--format <formats>', 'Output formats: nginx, caddy, netlify, cloudflare, all', 'all')
  .option('--out <dir>', 'Output directory', '.')
  .option('--gone', 'Emit 410 Gone rules for excluded/quarantined records', false)
  .option('--dry-run', 'Print the rules instead of writing files', false)
  .action((opts) => {
    try {
      const reportPath = resolve(opts.report);
      if (!existsSync(reportPath)) {
        console.error(chalk.red(`✗ No migration report found at ${reportPath}`));
        console.error(chalk.red('  Run `portage load` first, or pass --report <path>.'));
        process.exit(1);
      }

      const report = loadReport(reportPath);
      const rules = auditRedirects(report, { gone: opts.gone });
      const formats = parseFormats(opts.format);

      console.log('');
      console.log(chalk.dim('  → ') + `${report.records.length} records in ${chalk.cyan(opts.report)}`);
      console.log(chalk.dim('  → ') + `${rules.length} redirect rules${opts.gone ? ' (including 410 Gone)' : ''}`);
      console.log('');

      if (opts.dryRun) {
        printRules(rules);
        console.log('');
        console.log(chalk.yellow('Dry run — nothing written'));
        return;
      }

      if (rules.length === 0) {
        console.log(chalk.yellow('No redirect rules to write — every migrated URL kept its path.'));
        return;
      }

      const files = writeAuditFiles(rules, resolve(opts.out), formats);
      for (const file of files) {
        console.log(chalk.dim('  → ') + `${file.format.padEnd(10)} ${file.path}`);
      }
      console.log('');
      console.log(chalk.green(`Wrote ${files.length} redirect file(s) to ${chalk.cyan(opts.out)}`));
    } catch (err) {
      console.error(chalk.red('slug-audit failed'));
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

/** Reads the site URL from a written astro.config.mjs, if present. */
function readAstroSiteUrl(targetDir: string): string | null {
  const configPath = resolve(targetDir, 'astro.config.mjs');
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/site:\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

program.parse();
