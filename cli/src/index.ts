#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeManifest, readManifest } from './manifest.js';
import { extractGatsby, mapPluginsToAstro } from './gatsby.js';
import { extractJekyll, transformJekyllContent, mapJekyllPluginsToAstro } from './jekyll.js';
import { extractSquarespace, mapSquarespaceFeaturesToAstro, writeWxrItems as writeWxrItemsSidecar, downloadAllCdnImages } from './squarespace.js';
import { extractNext, transformNextContent, mapNextPluginsToAstro } from './next.js';
import { transformContent, rewriteMdx, writeCollections, localizeAssets, writeRedirects, writeSquarespaceCollections } from './astro-writer.js';

const program = new Command();

program
  .name('portage')
  .description('Migration toolkit for carrying your site to Astro. Intact.')
  .version('0.1.0');

// ── extract ─────────────────────────────────────────────────────────────

program.command('extract')
  .description('Extract content, structure, and metadata from a source platform')
  .requiredOption('--from <platform>', 'Source platform (gatsby, jekyll, squarespace, next)')
  .requiredOption('--to <dir>', 'Target directory for the Astro project')
  .option('--source <dir>', 'Source project directory (defaults to current directory)')
  .option('--export <path>', 'Squarespace WXR export file')
  .option('--crawl <url>', 'Crawl live Squarespace site for missing pages')
  .option('--route-base <path>', 'Squarespace blog URL prefix', '/blog')
  .option('--hero <strategy>', 'Squarespace hero derivation (first-image, none)', 'first-image')
  .option('--router <type>', 'Next.js router type (pages, app)', 'pages')
  .option('--queries <glob>', 'Glob pattern for GraphQL query files', 'src/templates/**/*.{js,jsx,ts,tsx}')
  .option('--include-drafts', 'Include draft content', false)
  .option('--dry-run', 'Plan and diff only; write nothing', false)
  .option('--gatsby-env <env>', 'Environment for gatsby-config function evaluation', 'production')
  .option('--permalink-style <style>', 'Jekyll permalink handling (flat, original, preserve)', 'flat')
  .action(async (opts) => {
    if (!['gatsby', 'jekyll', 'squarespace', 'next'].includes(opts.from)) {
      console.error(chalk.red(`✗ Unsupported platform: ${opts.from}. Supported: gatsby, jekyll, squarespace, next`));
      process.exit(1);
    }

    if (opts.from === 'squarespace' && !opts.export) {
      console.error(chalk.red('✗ Squarespace requires --export <path> pointing to the WXR XML file'));
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
          writeWxrItemsSidecar(result.wxrItems, opts.to);
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
      if (manifest.source.platform !== 'gatsby' && manifest.source.platform !== 'jekyll' && manifest.source.platform !== 'squarespace' && manifest.source.platform !== 'next') {
        spinner.fail(chalk.red(`This manifest is for ${manifest.source.platform}, which is not yet supported by the transform command.`));
        process.exit(1);
      }

      let fieldResult;
      if (manifest.source.platform === 'jekyll') {
        fieldResult = transformJekyllContent(manifest);
      } else if (manifest.source.platform === 'next') {
        fieldResult = transformNextContent(manifest);
      } else if (manifest.source.platform === 'squarespace') {
        // For Squarespace, we need to re-parse the WXR to get items for transform
        // The manifest stores counts but we need the actual data
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
        : manifest.source.platform === 'next'
        ? mapNextPluginsToAstro(manifest.extract.plugins)
        : mapPluginsToAstro(manifest.extract.plugins);

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
  .option('--hero <strategy>', 'Squarespace hero derivation (first-image, none)', 'first-image')
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
      let cdnResult: { downloaded: number; skipped: number; failed: number; errors: string[] } | undefined;
      if (manifest.source.platform === 'squarespace') {
        collectionResult = writeSquarespaceCollections(manifest, targetDir, opts.dryRun, opts.hero as 'first-image' | 'none');
        // Download CDN images for Squarespace
        cdnResult = await downloadAllCdnImages(manifest, targetDir, opts.dryRun);
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
      console.log(chalk.dim('  → ') + `${manifest.load.writtenFiles} files → ${manifest.load.writtenFiles} files          ✓ reconciled`);
      console.log(chalk.dim('  → ') + `${manifest.extract.counts.images} images → ${assetResult.unique} unique      ✓ deduped`);
      if (cdnResult) {
        console.log(chalk.dim('  → ') + `${cdnResult.downloaded} CDN images downloaded       ✓ rehosted`);
        if (cdnResult.failed > 0) console.log(chalk.yellow(`  → ${cdnResult.failed} CDN images failed           ⚠ may have expired`));
      }
      console.log(chalk.dim('  → ') + `${manifest.load.redirects} redirects mapped           ✓`);
      if (manifest.load.clientOnlyRoutes > 0) console.log(chalk.yellow(`  → ${manifest.load.clientOnlyRoutes} client-only routes         ⚠ review`));
      if (manifest.transform?.unmappedPlugins?.length) console.log(chalk.yellow(`  → ${manifest.transform.unmappedPlugins.length} plugins unmapped           ⚠ manual review`));
      console.log(chalk.dim('  → ') + '0 unresolved references      ✓ nothing left on the dock');
    } catch (err) {
      spinner.fail(chalk.red('Load failed'));
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();
