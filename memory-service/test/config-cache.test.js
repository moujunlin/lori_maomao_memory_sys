import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from '../config.js';
import * as cache from '../src/cache.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-config-'));
}

test.afterEach(() => {
  resetConfig();
  delete process.env.MEMORY_PORT;
  delete process.env.MEMORY_HOST;
  delete process.env.MEMORY_LLM_REVIEW_KEY;
  delete process.env.MEMORY_LLM_REALTIME_KEY;
  cache.clear();
});

test('config merges file config, env overrides, fallback, and absolute paths', async () => {
  const root = await tempDir();
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    server: { port: 3000 },
    paths: { memoriesDir: 'data', cacheDir: 'tmp-cache' },
    llm: { review: { apiKey: 'review-key', baseUrl: 'https://example.test/v1', model: 'review-model' } },
    cache: { hotBucketCapacity: 2 },
  }));
  process.env.MEMORY_PORT = '4000';
  process.env.MEMORY_HOST = '0.0.0.0';

  const cfg = loadConfig({ configPath, rootDir: root });

  assert.equal(cfg.server.port, 4000);
  assert.equal(cfg.server.host, '0.0.0.0');
  assert.equal(cfg.llm.realtime.apiKey, 'review-key');
  assert.equal(cfg.llm.realtime.baseUrl, 'https://example.test/v1');
  assert.equal(cfg.llm.realtime.model, 'review-model');
  assert.equal(cfg.paths.memoriesDirAbs, path.join(root, 'data'));
  assert.equal(cfg.paths.partnerNotesDirAbs, path.join(root, 'data', 'partner_notes'));
  assert.equal(cfg.paths.cacheDirAbs, path.join(root, 'tmp-cache'));
});

test('config rejects paths that escape their allowed parents', async () => {
  const root = await tempDir();
  const configPath = path.join(root, 'config.json');

  await fs.writeFile(configPath, JSON.stringify({ paths: { memoriesDir: '..' } }));
  assert.throws(() => loadConfig({ configPath, rootDir: root }), /paths\.memoriesDir/);

  resetConfig();
  await fs.writeFile(configPath, JSON.stringify({ paths: { cacheDbFile: '../cache.db' } }));
  assert.throws(() => loadConfig({ configPath, rootDir: root }), /paths\.cacheDbFile/);
});

test('cache stores hot buckets with LRU eviction and clearable stats', async () => {
  const root = await tempDir();
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ cache: { hotBucketCapacity: 2 } }));
  loadConfig({ configPath, rootDir: root });

  cache.putBucket('a', { id: 'a' });
  cache.putBucket('b', { id: 'b' });
  assert.equal(cache.hasBucket('a'), true);
  assert.equal(cache.getBucket('a').id, 'a');
  cache.putBucket('c', { id: 'c' });

  assert.equal(cache.hasBucket('a'), true);
  assert.equal(cache.hasBucket('b'), false);
  assert.equal(cache.hasBucket('c'), true);
  assert.deepEqual(cache.stats(), { hotBucketsCount: 2 });

  cache.removeBucket('a');
  assert.equal(cache.hasBucket('a'), false);
  cache.clear();
  assert.deepEqual(cache.stats(), { hotBucketsCount: 0 });
});
