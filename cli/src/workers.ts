/**
 * Shared parallel execution with resume support. Processes items in
 * configurable concurrency, tracks progress, and can resume from a
 * checkpoint file.
 *
 * This is part of the portage-core shared pipeline.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────

export interface WorkerResult<T> {
  completed: T[];
  failed: Array<{ item: unknown; error: string }>;
  skipped: number;
  total: number;
  durationMs: number;
}

export interface Checkpoint {
  version: '1';
  completedKeys: string[];
  failedKeys: string[];
  startedAt: string;
  updatedAt: string;
}

export interface WorkerOptions {
  /** Maximum concurrent operations */
  concurrency?: number;
  /** Path to checkpoint file for resume support */
  checkpointPath?: string;
  /** Whether to resume from checkpoint */
  resume?: boolean;
  /** Key function: extract a unique key from each item */
  keyFn: (item: unknown) => string;
}

// ── Parallel Execution ──────────────────────────────────────────────────

export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  opts: WorkerOptions,
): Promise<WorkerResult<R>> {
  const concurrency = opts.concurrency || 3;
  const start = Date.now();
  const completed: R[] = [];
  const failed: Array<{ item: unknown; error: string }> = [];
  // skipped count computed at return time from items.length - queue.length

  // Resume: skip already-completed keys
  const completedKeys = new Set<string>();
  if (opts.resume && opts.checkpointPath) {
    const checkpoint = readCheckpoint(opts.checkpointPath);
    if (checkpoint) {
      for (const key of checkpoint.completedKeys) completedKeys.add(key);
    }
  }

  // Process in batches
  const queue = items.filter((item) => !completedKeys.has(opts.keyFn(item)));

  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(fn));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        completed.push(result.value);
      } else {
        failed.push({ item: batch[j], error: result.reason?.message || String(result.reason) });
      }
    }

    // Update checkpoint
    if (opts.checkpointPath) {
      for (const item of batch) {
        completedKeys.add(opts.keyFn(item));
      }
      writeCheckpoint(opts.checkpointPath, {
        version: '1',
        completedKeys: Array.from(completedKeys),
        failedKeys: failed.map((f) => opts.keyFn(f.item)),
        startedAt: new Date(start).toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return {
    completed,
    failed,
    skipped: items.length - queue.length,
    total: items.length,
    durationMs: Date.now() - start,
  };
}

// ── Checkpoint I/O ──────────────────────────────────────────────────────

function readCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCheckpoint(path: string, checkpoint: Checkpoint): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint, null, 2) + '\n', 'utf-8');
}

// ── Sequential fallback ─────────────────────────────────────────────────

export async function sequentialMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  opts?: Partial<WorkerOptions>,
): Promise<WorkerResult<R>> {
  return parallelMap(items, fn, {
    concurrency: 1,
    keyFn: opts?.keyFn || ((_item: unknown) => String(Math.random())),
    ...opts,
  });
}
