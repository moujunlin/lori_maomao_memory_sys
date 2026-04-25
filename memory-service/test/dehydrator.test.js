import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from '../config.js';
import { dehydrate } from '../src/dehydrator.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-dehydrator-'));
}

async function setupConfig(maxTurns = 50) {
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
    dehydrator: { maxTurns },
  }));
  return loadConfig({ configPath, rootDir: root });
}

function mockLlm(content, finishReason = 'stop') {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: {},
    }),
  });
}

test.afterEach(() => {
  resetConfig();
  delete globalThis.fetch;
});

test('dehydrator returns empty results for empty input and enforces max turns', async () => {
  await setupConfig(1);
  assert.deepEqual(await dehydrate([]), []);
  await assert.rejects(() => dehydrate([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ]), /turns/);
});

test('dehydrator normalizes valid LLM items, filters invalid ones, and maps source ranges', async () => {
  await setupConfig();
  mockLlm(`\`\`\`json
[
  {
    "type": "memory",
    "summary": "  User likes tea  ",
    "tags": ["preference", 3],
    "importance": 15,
    "sourceRange": { "start": 0, "end": 1 }
  },
  {
    "type": "feel",
    "summary": "User felt anxious",
    "tags": ["emotion"],
    "importance": 0,
    "sourceRange": { "start": 1, "end": 1 },
    "emotion": { "label": " anxious ", "valence": -2, "arousal": 2 }
  },
  { "type": "bad", "summary": "skip", "tags": [], "importance": 5, "sourceRange": { "start": 0, "end": 0 } }
]
\`\`\``);

  const result = await dehydrate([
    { role: 'system', content: 'ignored' },
    { role: 'user', content: '<tea>' },
    { role: 'assistant', content: 'ok' },
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    type: 'memory',
    summary: 'User likes tea',
    tags: ['preference'],
    importance: 10,
    sourceRange: { start: 1, end: 2 },
  });
  assert.deepEqual(result[1], {
    type: 'feel',
    summary: 'User felt anxious',
    tags: ['emotion'],
    importance: 1,
    sourceRange: { start: 2, end: 2 },
    emotion: { label: 'anxious', valence: -1, arousal: 1 },
  });
});

test('dehydrator deduplicates concurrent identical LLM requests', async () => {
  await setupConfig();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ message: { content: '[]' }, finish_reason: 'stop' }],
        usage: {},
      }),
    };
  };

  const turns = [{ role: 'user', content: 'same' }];
  const [a, b] = await Promise.all([dehydrate(turns), dehydrate(turns)]);

  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
  assert.equal(calls, 1);
});

test('dehydrator rejects malformed or incomplete LLM responses', async () => {
  await setupConfig();

  mockLlm('{bad json');
  await assert.rejects(() => dehydrate([{ role: 'user', content: 'x' }]), /JSON/);

  mockLlm('[]', 'length');
  await assert.rejects(() => dehydrate([{ role: 'user', content: 'x' }]), /finishReason/);

  mockLlm('{}');
  await assert.rejects(() => dehydrate([{ role: 'user', content: 'x' }]), /array|数组|鏁扮粍/);
});
