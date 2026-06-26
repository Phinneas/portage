import { z } from 'zod';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const ContentFileSchema = z.object({
  relativePath: z.string(),
  absolutePath: z.string(),
  checksum: z.string(),
  format: z.enum(['md', 'mdx', 'json', 'html']),
  collection: z.string(),
});

export const PluginMappingSchema = z.object({
  gatsbyPlugin: z.string(),
  astroEquivalent: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  needsReview: z.boolean().default(false),
});

export const QueryMappingSchema = z.object({
  sourceFile: z.string(),
  nodeType: z.string(),
  fields: z.array(z.string()),
  resolved: z.boolean().default(true),
});

export const ManifestSchema = z.object({
  version: z.literal('1'),
  source: z.object({
    platform: z.enum(['gatsby', 'ghost', 'squarespace', 'substack', 'jekyll', 'next']),
    path: z.string(),
  }),
  extract: z.object({
    contentFiles: z.array(ContentFileSchema),
    images: z.array(z.object({
      relativePath: z.string(),
      absolutePath: z.string(),
      source: z.enum(['src/images', 'static', 'remote', 'next/image', 'public']),
      checksum: z.string().optional(),
    })),
    plugins: z.array(PluginMappingSchema),
    queries: z.array(QueryMappingSchema),
    counts: z.object({
      posts: z.number(),
      pages: z.number(),
      tags: z.number(),
      authors: z.number(),
      images: z.number(),
      plugins: z.number(),
      queries: z.number(),
    }),
  }),
  transform: z.object({
    fieldMappings: z.number().default(0),
    rewrites: z.array(z.object({
      file: z.string(),
      type: z.enum(['link', 'image', 'plugin', 'fragment', 'other']),
      from: z.string(),
      to: z.string(),
    })).default([]),
    unmappedPlugins: z.array(z.string()).default([]),
  }).optional(),
  load: z.object({
    writtenFiles: z.number().default(0),
    redirects: z.number().default(0),
    clientOnlyRoutes: z.number().default(0),
    skippedDrafts: z.number().default(0),
  }).optional(),
});

export type ContentFile = z.infer<typeof ContentFileSchema>;
export type PluginMapping = z.infer<typeof PluginMappingSchema>;
export type QueryMapping = z.infer<typeof QueryMappingSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export function checksumFile(absolutePath: string): string {
  const buf = readFileSync(absolutePath);
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

export function createManifest(platform: string, sourcePath: string): Manifest {
  return {
    version: '1',
    source: {
      platform: platform as Manifest['source']['platform'],
      path: resolve(sourcePath),
    },
    extract: {
      contentFiles: [],
      images: [],
      plugins: [],
      queries: [],
      counts: { posts: 0, pages: 0, tags: 0, authors: 0, images: 0, plugins: 0, queries: 0 },
    },
  };
}

export function writeManifest(manifest: Manifest, targetDir: string): void {
  const path = resolve(targetDir, 'portage.manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

export function readManifest(targetDir: string): Manifest | null {
  const path = resolve(targetDir, 'portage.manifest.json');
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return ManifestSchema.parse(raw);
}
