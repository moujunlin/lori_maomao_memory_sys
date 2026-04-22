// ============================================================
// 模块：内存索引 + Fuse 检索
// 职责：服务启动时扫描 memories/ 建立内存索引，运行时提供 CRUD 和检索
// 索引不含 content 全文，全文按需从文件读
// ============================================================

import path from 'node:path';
import Fuse from 'fuse.js';
import * as storage from './storage.js';

const FIELD_DEFAULTS = {
  importance: 5, valence: 0, arousal: 0, resolved: false,
  digested: false, pinned: false, activationCount: 1,
  tags: [], type: 'event', summary: '',
};

let _cfg = null;
let _index = new Map();
let _fuse = null;

export function inferDomainFromPath(absFilePath) {
  if (!_cfg) return null;
  const rel = path.relative(_cfg.paths.memoriesDirAbs, absFilePath);
  const first = rel.split(path.sep)[0];
  const sd = _cfg.paths.subdirs;
  if (first === sd.dynamic) return 'dynamic';
  if (first === sd.archived) return 'archived';
  if (first === sd.feel) return 'feel';
  return null;
}

function inferDomain(absFilePath) {
  const d = inferDomainFromPath(absFilePath);
  if (!d) console.warn(`[indexer] 无法推断 domain: ${path.relative(_cfg.paths.memoriesDirAbs, absFilePath)}，跳过`);
  return d;
}

// ⚠ 命名规则须与 bucket_manager.create() 对齐：{name}_{id}.md 或 {id}.md
function extractId(basename) {
  return basename.replace(/\.md$/, '').split('_').pop();
}

async function buildEntry(absFilePath) {
  const read = await storage.readBucketFile(absFilePath);
  if (!read) return null;
  const domain = inferDomain(absFilePath);
  if (!domain) return null;
  const m = read.metadata || {};
  const id = extractId(path.basename(absFilePath));
  const rel = path.relative(_cfg.paths.memoriesDirAbs, absFilePath);
  return {
    id, filePath: rel, domain,
    type: m.type ?? FIELD_DEFAULTS.type,
    importance: m.importance ?? FIELD_DEFAULTS.importance,
    valence: m.valence ?? FIELD_DEFAULTS.valence,
    arousal: m.arousal ?? FIELD_DEFAULTS.arousal,
    resolved: m.resolved ?? FIELD_DEFAULTS.resolved,
    digested: m.digested ?? FIELD_DEFAULTS.digested,
    pinned: m.pinned ?? FIELD_DEFAULTS.pinned,
    activationCount: m.activationCount ?? FIELD_DEFAULTS.activationCount,
    createdAt: m.createdAt ?? new Date().toISOString(),
    updatedAt: m.updatedAt ?? new Date().toISOString(),
    lastAccessedAt: m.lastAccessedAt ?? new Date().toISOString(),
    tags: Array.isArray(m.tags) ? m.tags : [...FIELD_DEFAULTS.tags],
    summary: m.summary ?? FIELD_DEFAULTS.summary,
    score: null,
  };
}

function rebuildFuse() {
  _fuse = new Fuse([..._index.values()], {
    keys: ['tags', 'summary'],
    threshold: (_cfg.matching?.fuzzyThreshold ?? 50) / 100,
    includeScore: true,
  });
}

// ========== 生命周期 ==========

export async function buildIndex(config) {
  _cfg = config;
  _index.clear();
  _fuse = null;
  const all = await storage.listMdFiles(_cfg.paths.memoriesDirAbs);
  const nb = path.join(_cfg.paths.memoriesDirAbs, _cfg.paths.subdirs.notebook, _cfg.notebook.filename);
  for (const p of all) {
    if (path.resolve(p) === path.resolve(nb)) continue;
    try {
      const e = await buildEntry(p);
      if (!e) continue;
      if (_index.has(e.id)) {
        console.warn(`[indexer] 重复 id ${e.id}: ${_index.get(e.id).filePath} vs ${e.filePath}，跳过后者`);
        continue;
      }
      _index.set(e.id, e);
    }
    catch (e) { console.warn(`[indexer] 建索引失败 ${p}: ${e.message}`); }
  }
  rebuildFuse();
  console.log(`[indexer] 索引就绪: ${_index.size} 条`);
}

export async function rescan() {
  await buildIndex(_cfg);
}

// ========== CRUD（统一走 batchUpdate，fuse 重建只有一个入口） ==========

export function batchUpdate(updates) {
  for (const u of updates) {
    if (u.op === 'set') {
      if (!u.entry?.id) throw new Error('[indexer] batchUpdate set 缺少 id');
      _index.set(u.entry.id, u.entry);
    } else if (u.op === 'patch') {
      const e = _index.get(u.id);
      if (e) Object.assign(e, u.partial);
    } else if (u.op === 'remove') {
      _index.delete(u.id);
    }
  }
  rebuildFuse();
}

export function addEntry(entry) {
  if (!entry?.id) throw new Error('[indexer] addEntry 缺少 id');
  if (_index.has(entry.id)) {
    console.warn(`[indexer] addEntry 重复 id ${entry.id}，已存在 ${_index.get(entry.id).filePath}，跳过`);
    return;
  }
  batchUpdate([{ op: 'set', entry }]);
}
export function updateEntry(id, partial) { batchUpdate([{ op: 'patch', id, partial }]); }
export function removeEntry(id) { batchUpdate([{ op: 'remove', id }]); }

// ========== 查询 ==========

export function get(id) { return _index.get(id); }
export function list() { return [..._index.values()]; }
export function listByDomain(domain) { return [..._index.values()].filter(e => e.domain === domain); }
export function getFuse() { return _fuse; }

export function pulse() {
  const byDomain = {};
  let unresolved = 0;
  for (const e of _index.values()) {
    byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
    if (!e.resolved) unresolved++;
  }
  return { total: _index.size, byDomain, unresolved };
}

// ========== 刷新 ==========

export async function refresh(id) {
  const e = _index.get(id);
  if (!e) return null;
  const abs = path.join(_cfg.paths.memoriesDirAbs, e.filePath);
  const fresh = await buildEntry(abs);
  if (!fresh) { removeEntry(id); return null; }
  updateEntry(id, fresh);
  return fresh;
}
