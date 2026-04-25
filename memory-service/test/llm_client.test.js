import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from '../config.js';
import { callLlm, callRealtime, LlmError } from '../src/llm_client.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-llm-'));
}

async function setupConfig(overrides = {}) {
  const root = await tempDir();
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    llm: {
      realtime: {
        baseUrl: 'https://llm.test/v1/',
        apiKey: 'rt-key',
        model: 'rt-model',
        maxTokens: 111,
        temperature: null,
        timeoutMs: 1000,
      },
      review: {
        baseUrl: 'https://review.test/v1',
        apiKey: 'review-key',
        model: 'review-model',
        maxTokens: 222,
        temperature: 0.2,
        timeoutMs: 1000,
      },
    },
    ...overrides,
  }));
  return loadConfig({ configPath, rootDir: root });
}

function mockResponse({ ok = true, status = 200, body = {}, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test.afterEach(() => {
  resetConfig();
  delete globalThis.fetch;
});

test('llm client sends OpenAI-compatible requests and normalizes success responses', async () => {
  await setupConfig();
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return mockResponse({
      body: {
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    });
  };

  const result = await callRealtime({
    messages: [{ role: 'user', content: 'hi' }],
    responseFormat: { type: 'json_object' },
    stop: ['END'],
  });

  assert.equal(captured.url, 'https://llm.test/v1/chat/completions');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer rt-key');
  assert.equal(captured.body.model, 'rt-model');
  assert.equal(captured.body.max_tokens, 111);
  assert.equal('temperature' in captured.body, false);
  assert.deepEqual(captured.body.response_format, { type: 'json_object' });
  assert.deepEqual(captured.body.stop, ['END']);
  assert.equal(result.content, 'answer');
  assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
});

test('llm client classifies request validation and HTTP failures', async () => {
  await setupConfig();
  await assert.rejects(() => callLlm('bad', { messages: [{ role: 'user', content: 'x' }] }), (e) => {
    assert.equal(e instanceof LlmError, true);
    assert.equal(e.kind, 'response');
    return true;
  });
  await assert.rejects(() => callLlm('realtime', { messages: [] }), /messages/);

  globalThis.fetch = async () => mockResponse({ ok: false, status: 429, body: 'rate limited', headers: { 'retry-after': '7' } });
  await assert.rejects(() => callRealtime({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.equal(e.kind, 'rate_limit');
    assert.equal(e.status, 429);
    assert.equal(e.retryAfter, 7);
    return true;
  });

  globalThis.fetch = async () => mockResponse({ ok: false, status: 400, body: 'context length exceeded' });
  await assert.rejects(() => callRealtime({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.equal(e.kind, 'context_length');
    return true;
  });
});

test('llm client handles malformed success responses and transport errors', async () => {
  await setupConfig();

  globalThis.fetch = async () => mockResponse({ body: 'not-json' });
  await assert.rejects(() => callRealtime({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.equal(e.kind, 'response');
    return true;
  });

  globalThis.fetch = async () => mockResponse({ body: { choices: [{}] } });
  await assert.rejects(() => callRealtime({ messages: [{ role: 'user', content: 'hi' }] }), /choices/);

  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  await assert.rejects(() => callRealtime({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.equal(e.kind, 'transport');
    return true;
  });
});

test('llm client fails auth when api key is missing', async () => {
  await setupConfig({ llm: { realtime: { apiKey: '' }, review: { apiKey: '' } } });
  await assert.rejects(() => callRealtime({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.equal(e.kind, 'auth');
    return true;
  });
});
