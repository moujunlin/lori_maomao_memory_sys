// ============================================================
// 模块：热桶读缓存（减少重复读盘）
// 职责：不写盘，所有持久化写操作由 bucket_manager 负责
// ============================================================

import { getConfig } from '../config.js';

// Map 按插入顺序迭代，天然支持 LRU：命中时 delete+set 重新置顶
const _hotBuckets = new Map();

function _config() {
  return getConfig().cache || {};
}

// ---------- hotBuckets（LRU） ----------

export function hasBucket(id) {
  return _hotBuckets.has(id);
}

export function getBucket(id) {
  const bucket = _hotBuckets.get(id);
  if (bucket) {
    // 重新置顶，更新使用顺序
    _hotBuckets.delete(id);
    _hotBuckets.set(id, bucket);
  }
  return bucket || undefined;
}

export function putBucket(id, bucket) {
  if (!id || !bucket) return;

  if (_hotBuckets.has(id)) {
    _hotBuckets.delete(id);
  }

  const limit = _config().hotBucketCapacity ?? 50;
  if (_hotBuckets.size >= limit) {
    // 踢掉最久未用的（Map 第一个 key）
    const oldest = _hotBuckets.keys().next().value;
    _hotBuckets.delete(oldest);
  }

  _hotBuckets.set(id, bucket);
}

export function removeBucket(id) {
  if (!id) return;
  _hotBuckets.delete(id);
}

// ---------- 全局操作 ----------

export function clear() {
  _hotBuckets.clear();
}

export function stats() {
  return {
    hotBucketsCount: _hotBuckets.size,
  };
}
