import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  bucketFilename,
  bucketFilePath,
  deleteBucketFile,
  ensureDir,
  findBucketFileById,
  listMdFiles,
  listPartnerNotes,
  moveBucketFile,
  notebookFilePath,
  partnerNoteFilePath,
  primaryDomain,
  readBucketFile,
  readNotebookFile,
  readPartnerNote,
  safePath,
  sanitizeName,
  typeDirFor,
  writeBucketFile,
  writeNotebookFile,
  writePartnerNote,
} from '../src/storage.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-storage-'));
}

const subdirs = {
  dynamic: 'dynamic',
  archived: 'archived',
  feel: 'feel',
  notebook: 'notebook',
};

test('storage path helpers sanitize unsafe names and constrain paths', () => {
  const root = path.join(os.tmpdir(), 'memory-root');

  assert.equal(sanitizeName(' a/b:c* '), 'a_b_c_');
  assert.equal(sanitizeName('', 'fallback'), 'fallback');
  assert.equal(sanitizeName('...', 'fallback'), 'fallback');
  assert.throws(() => safePath(root, '..'), /storage/);
  assert.equal(typeDirFor(root, 'dynamic', subdirs), path.join(root, 'dynamic'));
  assert.equal(typeDirFor(root, 'archive', subdirs), path.join(root, 'archived'));
  assert.throws(() => typeDirFor(root, 'unknown', subdirs), /bucket type/);
  assert.equal(primaryDomain(['topic/a'], 'dynamic'), 'topic_a');
  assert.equal(primaryDomain([], 'dynamic'), sanitizeName(undefined));
  assert.equal(primaryDomain(['topic'], 'feel'), primaryDomain(['other'], 'feel'));
  assert.equal(bucketFilename('name', 'bkt_123'), 'name_bkt_123.md');
  assert.equal(bucketFilename('', 'bkt_123'), 'bkt_123.md');

  const fp = bucketFilePath(root, 'dynamic', ['topic/a'], 'n', 'bkt_123', subdirs);
  assert.equal(fp, path.join(root, 'dynamic', 'topic_a', 'n_bkt_123.md'));
});

test('storage reads, writes, moves, lists, and deletes bucket files', async () => {
  const root = await tempDir();
  const fp = bucketFilePath(root, 'dynamic', ['project'], 'memo', 'bkt_abc', subdirs);

  assert.equal(await readBucketFile(fp), null);
  await writeBucketFile(fp, { id: 'bkt_abc', tags: ['project'] }, 'hello');

  const read = await readBucketFile(fp);
  assert.equal(read.metadata.id, 'bkt_abc');
  assert.equal(read.content.trim(), 'hello');

  assert.deepEqual((await listMdFiles(root)).map((p) => path.basename(p)), ['memo_bkt_abc.md']);
  assert.equal(await findBucketFileById('bkt_abc', [root]), fp);
  assert.equal(await findBucketFileById('', [root]), null);

  const dest = bucketFilePath(root, 'archived', ['project'], 'memo', 'bkt_abc', subdirs);
  assert.equal(await moveBucketFile(fp, dest), dest);
  assert.equal(await readBucketFile(fp), null);
  assert.equal((await readBucketFile(dest)).metadata.id, 'bkt_abc');
  assert.equal(await deleteBucketFile(dest), true);
  assert.equal(await deleteBucketFile(dest), false);
});

test('storage handles notebook and partner note files', async () => {
  const root = await tempDir();
  const notebook = notebookFilePath(root, subdirs, 'notebook.md');

  assert.equal(await readNotebookFile(notebook), null);
  await writeNotebookFile(notebook, 'todo');
  assert.equal(await readNotebookFile(notebook), 'todo');
  assert.throws(() => notebookFilePath(root, subdirs, '../escape.md'), /storage/);

  const partnerDir = path.join(root, 'partner_notes');
  assert.equal(await readPartnerNote(partnerDir, 'alice'), null);
  assert.throws(() => partnerNoteFilePath(partnerDir, 'bad/name'), /partnerNote/);

  await writePartnerNote(partnerDir, 'alice', { title: 'Alice' }, 'note');
  await writePartnerNote(partnerDir, 'bob', { created: '2020-01-01' }, 'note2');
  await ensureDir(path.join(partnerDir, 'nested'));
  await writeBucketFile(path.join(partnerDir, 'nested', 'ignored.md'), { id: 'ignored' }, 'x');

  const alice = await readPartnerNote(partnerDir, 'alice');
  assert.equal(alice.id, 'alice');
  assert.equal(alice.meta.id, 'alice');
  assert.equal(alice.meta.title, 'Alice');
  assert.equal(alice.corrupted, false);
  assert.equal(alice.content.trim(), 'note');

  const notes = await listPartnerNotes(partnerDir);
  assert.deepEqual(notes.map((n) => n.id).sort(), ['alice', 'bob']);
});
