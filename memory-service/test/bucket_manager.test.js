import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from '../config.js';
import * as bucketManager from '../src/bucket_manager.js';
import * as indexer from '../src/indexer.js';
import * as cache from '../src/cache.js';
import { readBucketFile } from '../src/storage.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-buckets-'));
}

async function setup() {
  const root = await tempDir();
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ llm: { review: { apiKey: 'key' } } }));
  const cfg = loadConfig({ configPath, rootDir: root });
  await indexer.buildIndex(cfg);
  bucketManager.init(cfg);
  return cfg;
}

test.afterEach(() => {
  resetConfig();
  cache.clear();
});

test('bucket_manager creates, updates, resolves, archives, merges, and removes buckets', async () => {
  const cfg = await setup();

  const first = await bucketManager.create({
    domain: 'dynamic',
    name: 'first',
    tags: ['topic'],
    summary: 'first summary',
    importance: 6,
  }, 'first content');
  const second = await bucketManager.create({
    domain: 'dynamic',
    name: 'second',
    tags: ['topic'],
    summary: 'second summary',
  }, 'second content');

  assert.equal(indexer.get(first.id).summary, 'first summary');
  const createdFile = await readBucketFile(path.join(cfg.paths.memoriesDirAbs, first.filePath));
  assert.equal(createdFile.content.trim(), 'first content');
  assert.equal(createdFile.metadata.id, first.id);

  cache.putBucket(first.id, { cached: true });
  const updated = await bucketManager.update(first.id, { id: 'bkt_badbadbad00', summary: 'updated', tags: ['new'] }, 'updated content');
  assert.equal(updated.summary, 'updated');
  assert.equal(cache.hasBucket(first.id), false);
  const updatedFile = await readBucketFile(path.join(cfg.paths.memoriesDirAbs, first.filePath));
  assert.equal(updatedFile.metadata.id, first.id);

  await bucketManager.resolve(first.id);
  assert.equal(indexer.get(first.id).resolved, true);

  const archived = await bucketManager.archive(first.id);
  assert.equal(archived.domain, 'archived');
  assert.match(archived.filePath, /archived/);
  const archivedFile = await readBucketFile(path.join(cfg.paths.memoriesDirAbs, archived.filePath));
  assert.equal(archivedFile.metadata.id, first.id);

  const merged = await bucketManager.merge(first.id, {
    id: 'bkt_badbadbad11',
    summary: 'merged',
    tags: ['merged'],
  }, 'merged content', second.id);
  assert.equal(merged.summary, 'merged');
  assert.equal(indexer.get(second.id), undefined);
  const mergedFile = await readBucketFile(path.join(cfg.paths.memoriesDirAbs, merged.filePath));
  assert.equal(mergedFile.metadata.id, first.id);

  assert.equal(await bucketManager.remove(first.id), true);
  assert.equal(await bucketManager.remove(first.id), false);
  assert.equal(indexer.get(first.id), undefined);
});

test('bucket_manager rejects invalid operations', async () => {
  await setup();

  await assert.rejects(() => bucketManager.update('missing', {}, undefined), /update/);
  await assert.rejects(() => bucketManager.archive('missing'), /archive/);
  await assert.rejects(() => bucketManager.merge('same', {}, '', 'same'), /targetId === sourceId/);
});
