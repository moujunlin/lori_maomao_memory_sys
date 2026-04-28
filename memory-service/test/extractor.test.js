import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from '../config.js';
import * as indexer from '../src/indexer.js';
import * as bucketManager from '../src/bucket_manager.js';
import { readBucketFile } from '../src/storage.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-extractor-'));
}

async function setup(extraConfig = {}) {
  const root = await tempDir();
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    llm: {
      realtime: {
        baseUrl: 'https://llm.test/v1',
        apiKey: 'rt-key',
        model: 'rt-model',
        timeoutMs: 1000,
      },
      review: { apiKey: 'review-key' },
    },
    merge: { threshold: 75 },
    matching: { fuzzyThreshold: 35 },
    ...extraConfig,
  }));
  const cfg = loadConfig({ configPath, rootDir: root });
  await indexer.buildIndex(cfg);
  bucketManager.init(cfg);
  return cfg;
}

async function loadExtractor() {
  return import('../src/extractor.js');
}

async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
}

test.afterEach(() => {
  resetConfig();
  delete globalThis.fetch;
});

test('extractor.hold creates one bucket for one valid item', async () => {
  const cfg = await setup();
  const extractor = await loadExtractor();

  const result = await extractor.hold([
    {
      type: 'memory',
      summary: 'User likes jasmine tea',
      tags: ['preference'],
      importance: 7,
      sourceRange: { start: 0, end: 0 },
    },
  ], {
    sourceTurns: [{ role: 'user', content: 'I like jasmine tea.' }],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.merged.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(indexer.list().length, 1);

  const entry = indexer.get(result.created[0].id);
  assert.equal(entry.domain, 'dynamic');
  assert.equal(entry.summary, 'User likes jasmine tea');
  assert.deepEqual(entry.tags, ['preference']);
  assert.equal(entry.importance, 7);

  const file = await readBucketFile(path.join(cfg.paths.memoriesDirAbs, entry.filePath));
  assert.equal(file.metadata.id, result.created[0].id);
  assert.match(file.content, /jasmine tea/i);
});

test('extractor.hold does not merge a newly created bucket with itself', async () => {
  await setup({ merge: { threshold: 1 } });
  const extractor = await loadExtractor();

  const result = await extractor.hold([
    {
      type: 'memory',
      summary: 'Same batch item',
      tags: ['same'],
      importance: 5,
      sourceRange: { start: 0, end: 0 },
    },
  ], {
    sourceTurns: [{ role: 'user', content: 'Same batch item.' }],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.merged.length, 0);
  assert.equal(indexer.list().length, 1);
});

test('extractor.hold can merge a later item into an earlier similar bucket in the same batch', async () => {
  await setup({ merge: { threshold: 1 } });
  const extractor = await loadExtractor();

  const result = await extractor.hold([
    {
      type: 'memory',
      summary: 'User likes jasmine tea',
      tags: ['tea'],
      importance: 5,
      sourceRange: { start: 0, end: 0 },
    },
    {
      type: 'memory',
      summary: 'User enjoys jasmine tea in the evening',
      tags: ['tea'],
      importance: 8,
      sourceRange: { start: 1, end: 1 },
    },
  ], {
    sourceTurns: [
      { role: 'user', content: 'I like jasmine tea.' },
      { role: 'user', content: 'I enjoy jasmine tea in the evening.' },
    ],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.merged.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(indexer.list().length, 1);
  assert.equal(indexer.list()[0].importance, 8);
  assert.match(indexer.list()[0].summary, /jasmine tea/i);
});

test('extractor.hold records a failed item and continues processing the rest of the batch', async () => {
  await setup();
  const extractor = await loadExtractor();

  const result = await extractor.hold([
    {
      type: 'memory',
      summary: '',
      tags: ['bad'],
      importance: 5,
      sourceRange: { start: 0, end: 0 },
    },
    {
      type: 'memory',
      summary: 'User keeps a red notebook',
      tags: ['object'],
      importance: 6,
      sourceRange: { start: 1, end: 1 },
    },
  ], {
    sourceTurns: [
      { role: 'user', content: 'Bad extracted item.' },
      { role: 'user', content: 'I keep a red notebook.' },
    ],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /summary|invalid/i);
  assert.equal(indexer.list()[0].summary, 'User keeps a red notebook');
});

test('extractor.grow wraps raw text into a single user turn before calling dehydrator.dehydrate', async () => {
  await setup();
  const extractor = await loadExtractor();
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([{
              type: 'memory',
              summary: 'User likes rainy nights',
              tags: ['weather'],
              importance: 5,
              sourceRange: { start: 0, end: 0 },
            }]),
          },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
    };
  };

  const result = await extractor.grow('I like rainy nights.');

  assert.equal(result.created.length, 1);
  const prompt = requestBody.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /\[0\]\s+user:\s+I like rainy nights\./);
});

test('extractor.grow writes a pending file when dehydrator.dehydrate fails', async () => {
  const cfg = await setup();
  const extractor = await loadExtractor();
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  const result = await extractor.grow([{ role: 'user', content: 'Please remember this after retry.' }]);

  assert.equal(result.created.length, 0);
  assert.equal(result.pending.length, 1);
  assert.match(result.pending[0].id, /^pending_/);

  const pendingFiles = await listFiles(path.join(cfg.paths.memoriesDirAbs, 'pending'));
  assert.equal(pendingFiles.length, 1);
  const raw = JSON.parse(await fs.readFile(pendingFiles[0], 'utf-8'));
  assert.deepEqual(raw.turns, [{ role: 'user', content: 'Please remember this after retry.' }]);
  assert.equal(raw.attempts, 0);
});

test('extractor.growStructured skips invalid items and continues processing valid ones', async () => {
  await setup();
  const extractor = await loadExtractor();

  const result = await extractor.growStructured([
    { type: 'memory', summary: '', tags: [], importance: 5, sourceRange: { start: 0, end: 0 } },
    {
      type: 'feel',
      summary: 'Assistant felt relieved',
      tags: ['relief'],
      importance: 6,
      sourceRange: { start: 0, end: 0 },
      emotion: { label: 'relief', valence: 0.5, arousal: 0.3 },
    },
  ], {
    sourceTurns: [{ role: 'assistant', content: 'I felt relieved.' }],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(indexer.list()[0].domain, 'feel');
  assert.equal(indexer.list()[0].type, 'feel');
});

test('extractor.sweepPending increments attempts and preserves the file when retry fails', async () => {
  const cfg = await setup();
  const extractor = await loadExtractor();
  const pendingDir = path.join(cfg.paths.memoriesDirAbs, 'pending');
  await fs.mkdir(pendingDir, { recursive: true });
  const pendingPath = path.join(pendingDir, 'pending_retry.json');
  await fs.writeFile(pendingPath, JSON.stringify({
    id: 'pending_retry',
    attempts: 1,
    turns: [{ role: 'user', content: 'Retry me later.' }],
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
  }));
  globalThis.fetch = async () => {
    throw new Error('still down');
  };

  const result = await extractor.sweepPending();

  assert.equal(result.retried, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed.length, 1);
  const raw = JSON.parse(await fs.readFile(pendingPath, 'utf-8'));
  assert.equal(raw.attempts, 2);
  assert.deepEqual(raw.turns, [{ role: 'user', content: 'Retry me later.' }]);
});

test('indexer.findSimilar returns an empty array when no similar bucket is found', async () => {
  await setup();

  const result = indexer.findSimilar({
    summary: 'completely unrelated subject',
    tags: ['unrelated'],
  });

  assert.deepEqual(result, []);
});
