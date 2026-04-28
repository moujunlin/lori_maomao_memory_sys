import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from '../config.js';
import * as indexer from '../src/indexer.js';
import { writeBucketFile, deleteBucketFile } from '../src/storage.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-indexer-'));
}

async function makeConfig(root) {
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    llm: { review: { apiKey: 'key' } },
    matching: { fuzzyThreshold: 35 },
  }));
  return loadConfig({ configPath, rootDir: root });
}

test.afterEach(() => {
  resetConfig();
});

test('indexer builds entries from memory files and skips notebook/partner notes', async () => {
  const root = await tempDir();
  const cfg = await makeConfig(root);
  const dynamicId = 'bkt_aaaaaaaaaaaa';
  const archivedId = 'bkt_bbbbbbbbbbbb';
  const dynamic = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'project', `memo_${dynamicId}.md`);
  const archived = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.archived, 'old', `${archivedId}.md`);
  const notebook = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.notebook, cfg.notebook.filename);
  const partner = path.join(cfg.paths.partnerNotesDirAbs, 'note.md');

  await writeBucketFile(dynamic, {
    id: dynamicId,
    type: 'event',
    importance: 8,
    resolved: true,
    tags: ['project'],
    summary: 'alpha beta',
  }, 'content');
  await writeBucketFile(archived, { id: archivedId, summary: 'old item' }, 'content');
  await writeBucketFile(notebook, { summary: 'skip notebook' }, 'content');
  await writeBucketFile(partner, { summary: 'skip partner' }, 'content');

  await indexer.buildIndex(cfg);

  assert.equal(indexer.list().length, 2);
  assert.equal(indexer.get(dynamicId).domain, 'dynamic');
  assert.equal(indexer.get(dynamicId).importance, 8);
  assert.equal(indexer.get(dynamicId).resolved, true);
  assert.equal(indexer.get(archivedId).domain, 'archived');
  assert.deepEqual(indexer.listByDomain('dynamic').map((e) => e.id), [dynamicId]);
  assert.deepEqual(indexer.pulse(), {
    total: 2,
    byDomain: { dynamic: 1, archived: 1 },
    unresolved: 1,
  });
  assert.equal(indexer.getFuse().search('alpha').length, 1);
});

test('indexer supports batch updates, refresh, and removal when disk file is gone', async () => {
  const root = await tempDir();
  const cfg = await makeConfig(root);
  const bucketId = 'bkt_cccccccccccc';
  const fp = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'project', `memo_${bucketId}.md`);
  await writeBucketFile(fp, { id: bucketId, summary: 'before', tags: ['x'] }, 'content');
  await indexer.buildIndex(cfg);

  indexer.addEntry({ ...indexer.get(bucketId), id: 'manual', summary: 'manual' });
  assert.equal(indexer.get('manual').summary, 'manual');

  indexer.updateEntry('manual', { summary: 'patched' });
  assert.equal(indexer.get('manual').summary, 'patched');

  indexer.batchUpdate([{ op: 'remove', id: 'manual' }]);
  assert.equal(indexer.get('manual'), undefined);

  await writeBucketFile(fp, { id: bucketId, summary: 'after', tags: ['y'], activationCount: 7 }, 'new');
  const refreshed = await indexer.refresh(bucketId);
  assert.equal(refreshed.summary, 'after');
  assert.equal(refreshed.activationCount, 7);

  await deleteBucketFile(fp);
  assert.equal(await indexer.refresh(bucketId), null);
  assert.equal(indexer.get(bucketId), undefined);
});

test('indexer skips files whose frontmatter id does not match the filename id', async () => {
  const root = await tempDir();
  const cfg = await makeConfig(root);
  const metadataId = 'bkt_deadbeefcafe';
  const fileId = 'bkt_111111111111';
  const fp = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'project', `memo_${fileId}.md`);

  await writeBucketFile(fp, {
    id: metadataId,
    summary: 'filename wins',
    tags: ['project'],
  }, 'content');

  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    await indexer.buildIndex(cfg);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(indexer.get(fileId), undefined);
  assert.equal(indexer.get(metadataId), undefined);
  assert.deepEqual(indexer.list(), []);
  assert.ok(warns.some((msg) => msg.includes('frontmatter')));
});

test('indexer refresh keeps the old entry when the file still exists but frontmatter id becomes inconsistent', async () => {
  const root = await tempDir();
  const cfg = await makeConfig(root);
  const fileId = 'bkt_222222222222';
  const fp = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'project', `memo_${fileId}.md`);

  await writeBucketFile(fp, {
    id: fileId,
    summary: 'before',
    tags: ['x'],
  }, 'content');
  await indexer.buildIndex(cfg);

  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    await writeBucketFile(fp, {
      id: 'bkt_333333333333',
      summary: 'after',
      tags: ['y'],
    }, 'new');

    const refreshed = await indexer.refresh(fileId);
    assert.equal(refreshed.id, fileId);
    assert.equal(refreshed.summary, 'before');
    assert.equal(indexer.get(fileId)?.id, fileId);
    assert.equal(indexer.get(fileId)?.summary, 'before');
    assert.equal(indexer.get('bkt_333333333333'), undefined);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warns.some((msg) => msg.includes('frontmatter')));
  assert.ok(warns.some((msg) => msg.includes('refresh')));
});

test('indexer skips non-bucket markdown files under memory directories', async () => {
  const root = await tempDir();
  const cfg = await makeConfig(root);
  const validId = 'bkt_444444444444';
  const valid = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'project', `memo_${validId}.md`);
  const stray = path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'project', 'meeting-notes.md');

  await writeBucketFile(valid, { id: validId, summary: 'real bucket', tags: ['project'] }, 'content');
  await writeBucketFile(stray, { id: 'bkt_555555555555', summary: 'stray note', tags: ['project'] }, 'content');

  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    await indexer.buildIndex(cfg);
  } finally {
    console.warn = origWarn;
  }

  assert.deepEqual(indexer.list().map((e) => e.id), [validId]);
  assert.equal(indexer.get('meeting-notes'), undefined);
  assert.equal(indexer.get('bkt_555555555555'), undefined);
  assert.ok(warns.some((msg) => msg.includes('meeting-notes.md')));
});

test('indexer.findSimilar filters by score, id, domain, type, and max results', async () => {
  const root = await tempDir();
  const cfg = await makeConfig(root);
  const teaId = 'bkt_666666666666';
  const feelId = 'bkt_777777777777';
  const archivedId = 'bkt_888888888888';
  const coffeeId = 'bkt_999999999999';

  await writeBucketFile(
    path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'food', `memo_${teaId}.md`),
    { id: teaId, type: 'event', summary: 'User likes jasmine tea', tags: ['tea', 'preference'] },
    'content'
  );
  await writeBucketFile(
    path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.feel, `memo_${feelId}.md`),
    { id: feelId, type: 'feel', summary: 'Assistant feels calm about jasmine tea', tags: ['tea'] },
    'content'
  );
  await writeBucketFile(
    path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.archived, `memo_${archivedId}.md`),
    { id: archivedId, type: 'event', summary: 'Archived note about jasmine tea', tags: ['tea'] },
    'content'
  );
  await writeBucketFile(
    path.join(cfg.paths.memoriesDirAbs, cfg.paths.subdirs.dynamic, 'food', `memo_${coffeeId}.md`),
    { id: coffeeId, type: 'event', summary: 'User likes black coffee', tags: ['coffee'] },
    'content'
  );

  await indexer.buildIndex(cfg);

  assert.deepEqual(
    indexer.findSimilar({ summary: 'unrelated bicycle repair', tags: ['garage'] }, { threshold: 75 }),
    []
  );

  const dynamicEvents = indexer.findSimilar(
    { summary: 'jasmine tea preference', tags: ['tea'] },
    { threshold: 1, domain: 'dynamic', type: 'event', excludeId: coffeeId, maxResults: 1 }
  );

  assert.equal(dynamicEvents.length, 1);
  assert.equal(dynamicEvents[0].entry.id, teaId);
  assert.ok(dynamicEvents[0].score >= 1);

  const feelMatches = indexer.findSimilar(
    { summary: 'jasmine tea calm feeling', tags: ['tea'] },
    { threshold: 1, domain: 'feel', type: 'feel' }
  );

  assert.deepEqual(feelMatches.map((m) => m.entry.id), [feelId]);
});
