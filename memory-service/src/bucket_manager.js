// ============================================================
// 模块：桶管理器
// 职责：串行化同桶写操作，create/update/resolve/delete/merge/archive
// 所有写操作完成后同步更新 indexer 内存索引
// ============================================================

import path from 'node:path';
import * as storage from './storage.js';
import * as indexer from './indexer.js';
import * as cache from './cache.js';

const locks = new Map();
let _cfg = null;

export function init(config) { _cfg = config; }

function now() { return new Date().toISOString(); }

async function withLock(id, fn) {
  const prev = locks.get(id);
  const next = (async () => {
    if (prev) { try { await prev; } catch {} }
    return fn();
  })();
  locks.set(id, next);
  next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  return next;
}

// ⚠ Entry schema 须与 indexer.buildEntry 保持同步
function entryFromMeta(id, absPath, meta, overrides = {}) {
  const rel = path.relative(_cfg.paths.memoriesDirAbs, absPath);
  return {
    id, filePath: rel,
    domain: overrides.domain ?? indexer.inferDomainFromPath(absPath) ?? 'dynamic',
    type: meta.type ?? 'event',
    importance: meta.importance ?? 5,
    valence: meta.valence ?? 0,
    arousal: meta.arousal ?? 0,
    resolved: meta.resolved ?? false,
    digested: meta.digested ?? false,
    pinned: meta.pinned ?? false,
    activationCount: meta.activationCount ?? 1,
    createdAt: meta.createdAt ?? now(),
    updatedAt: now(),
    lastAccessedAt: now(),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    summary: meta.summary ?? '',
    score: null,
    ...overrides,
  };
}

// ========== create ==========
// metadata.domain = 存储目录（dynamic/archived/feel），默认 'dynamic'
// metadata.type   = 记忆类型（event/feel/reflection），默认 'event'
// metadata.tags   = 主题标签数组，用于二级目录，默认 ['未分类']

export async function create(metadata, content) {
  const id = storage.generateBucketId();
  const domain = metadata.domain || 'dynamic';
  const name = metadata.name || '';
  const topics = metadata.tags || ['未分类'];

  const absPath = storage.bucketFilePath(
    _cfg.paths.memoriesDirAbs, domain, topics, name, id, _cfg.paths.subdirs
  );

  const meta = { ...metadata, id, createdAt: now(), updatedAt: now(), lastAccessedAt: now() };
  await storage.writeBucketFile(absPath, meta, content);

  indexer.addEntry(entryFromMeta(id, absPath, meta));
  return { id, filePath: path.relative(_cfg.paths.memoriesDirAbs, absPath) };
}

// ========== update（强制读盘，防 Obsidian 外部编辑覆盖） ==========

export async function update(id, patchMetadata, patchContent) {
  return withLock(id, async () => {
    const entry = indexer.get(id);
    if (!entry) throw new Error(`[bucket_manager] update 未找到: ${id}`);

    const absPath = path.join(_cfg.paths.memoriesDirAbs, entry.filePath);
    const read = await storage.readBucketFile(absPath);
    if (!read) throw new Error(`[bucket_manager] update 读盘失败: ${absPath}`);

    const mergedMeta = { ...read.metadata, ...patchMetadata, updatedAt: now() };
    const mergedContent = patchContent !== undefined ? patchContent : read.content;
    await storage.writeBucketFile(absPath, mergedMeta, mergedContent);

    indexer.updateEntry(id, entryFromMeta(id, absPath, mergedMeta, { domain: entry.domain }));
    cache.removeBucket(id);
    return indexer.get(id);
  });
}

// ========== resolve ==========

export async function resolve(id) {
  return update(id, { resolved: true });
}

// ========== delete ==========

export async function remove(id) {
  return withLock(id, async () => {
    const entry = indexer.get(id);
    if (!entry) return false;
    const absPath = path.join(_cfg.paths.memoriesDirAbs, entry.filePath);
    await storage.deleteBucketFile(absPath);
    indexer.removeEntry(id);
    cache.removeBucket(id);
    return true;
  });
}

// ========== merge（调用方算好合并内容，bucket_manager 只执行原子操作） ==========

export async function merge(targetId, mergedMetadata, mergedContent, sourceId) {
  if (targetId === sourceId) throw new Error('[bucket_manager] merge: targetId === sourceId');
  const [first, second] = [targetId, sourceId].sort();
  return withLock(first, () => withLock(second, async () => {
    const target = indexer.get(targetId);
    const source = indexer.get(sourceId);
    if (!target) throw new Error(`[bucket_manager] merge target 未找到: ${targetId}`);
    if (!source) throw new Error(`[bucket_manager] merge source 未找到: ${sourceId}`);

    const targetAbs = path.join(_cfg.paths.memoriesDirAbs, target.filePath);
    const sourceAbs = path.join(_cfg.paths.memoriesDirAbs, source.filePath);

    const meta = { ...mergedMetadata, updatedAt: now() };
    await storage.writeBucketFile(targetAbs, meta, mergedContent);
    await storage.deleteBucketFile(sourceAbs);

    indexer.batchUpdate([
      { op: 'patch', id: targetId, partial: entryFromMeta(targetId, targetAbs, meta, { domain: target.domain }) },
      { op: 'remove', id: sourceId },
    ]);
    cache.removeBucket(targetId);
    cache.removeBucket(sourceId);
    return indexer.get(targetId);
  }));
}

// ========== archive（decay 直接调用，低于阈值即移目录） ==========

export async function archive(id) {
  return withLock(id, async () => {
    const entry = indexer.get(id);
    if (!entry) throw new Error(`[bucket_manager] archive 未找到: ${id}`);
    if (entry.domain === 'archived') return entry;

    const srcAbs = path.join(_cfg.paths.memoriesDirAbs, entry.filePath);
    const read = await storage.readBucketFile(srcAbs);
    if (!read) throw new Error(`[bucket_manager] archive 读盘失败: ${srcAbs}`);

    const meta = { ...read.metadata, updatedAt: now() };
    const topics = Array.isArray(meta.tags) && meta.tags.length ? meta.tags : ['未分类'];
    const destAbs = storage.bucketFilePath(
      _cfg.paths.memoriesDirAbs, 'archived', topics, meta.name || '', id, _cfg.paths.subdirs
    );

    await storage.writeBucketFile(destAbs, meta, read.content);
    await storage.deleteBucketFile(srcAbs);

    const rel = path.relative(_cfg.paths.memoriesDirAbs, destAbs);
    indexer.updateEntry(id, { domain: 'archived', filePath: rel, updatedAt: now() });
    cache.removeBucket(id);
    return indexer.get(id);
  });
}
