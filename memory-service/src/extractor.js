import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import * as dehydrator from './dehydrator.js';
import * as bucketManager from './bucket_manager.js';
import * as indexer from './indexer.js';

function generatePendingId() {
  return 'pending_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function writePending(pending) {
  const pendingDir = path.join(getConfig().paths.memoriesDirAbs, 'pending');
  await fs.mkdir(pendingDir, { recursive: true });
  const filePath = path.join(pendingDir, `${pending.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(pending, null, 2));
  return pending;
}

export async function hold(items, options = {}) {
  const created = [];
  const merged = [];
  const failed = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      failed.push({ item, reason: 'invalid: not an object' });
      continue;
    }
    if (typeof item.summary !== 'string' || item.summary.trim().length === 0) {
      failed.push({ item, reason: 'invalid: empty or missing summary' });
      continue;
    }

    const type = item.type === 'memory' ? 'event' : item.type;
    // domain 判断基于原始 type（映射前）：feel → feel，其他一律 dynamic
    const domain = item.type === 'feel' ? 'feel' : 'dynamic';

    const metadata = {
      type,
      domain,
      summary: item.summary.trim(),
      tags: Array.isArray(item.tags) ? item.tags : [],
      importance: typeof item.importance === 'number' ? item.importance : 5,
    };

    if (item.type === 'feel' && item.emotion) {
      metadata.valence = item.emotion.valence;
      metadata.arousal = item.emotion.arousal;
    }

    const content = item.summary.trim();

    try {
      const result = await bucketManager.create(metadata, content);
      created.push(result);

      const similar = indexer.findSimilar(
        { summary: item.summary, tags: item.tags || [] },
        {
          excludeId: result.id,
          threshold: getConfig().merge?.threshold ?? 75,
          maxResults: 5,
          domain,
          type,
        }
      );

      if (similar.length > 0) {
        const best = similar[0];
        const targetId = best.entry.id;
        const sourceId = result.id;

        const targetEntry = indexer.get(targetId);
        const sourceEntry = indexer.get(sourceId);

        const mergedMeta = {
          type: targetEntry.type,
          summary: targetEntry.summary + '\n\n（合并自：' + sourceEntry.summary + '）',
          importance: Math.max(targetEntry.importance || 5, sourceEntry.importance || 5),
          activationCount: (targetEntry.activationCount || 1) + (sourceEntry.activationCount || 1),
          tags: [...new Set([...(targetEntry.tags || []), ...(sourceEntry.tags || [])])],
          createdAt: targetEntry.createdAt,
          updatedAt: new Date().toISOString(),
          valence: targetEntry.valence ?? 0,
          arousal: targetEntry.arousal ?? 0,
        };

        if (targetEntry.type === 'feel' && sourceEntry.type === 'feel') {
          const totalAct = mergedMeta.activationCount;
          const tAct = targetEntry.activationCount || 1;
          const sAct = sourceEntry.activationCount || 1;
          mergedMeta.valence = ((targetEntry.valence * tAct) + (sourceEntry.valence * sAct)) / totalAct;
          mergedMeta.arousal = ((targetEntry.arousal * tAct) + (sourceEntry.arousal * sAct)) / totalAct;
        }

        const mergedContent = targetEntry.summary + '\n\n---\n\n' + sourceEntry.summary;

        try {
          await bucketManager.merge(targetId, mergedMeta, mergedContent, sourceId);
          merged.push({ targetId, sourceId });
          const idx = created.findIndex(c => c.id === sourceId);
          if (idx !== -1) created.splice(idx, 1);
        } catch (e) {
          console.warn(`[extractor] merge failed: ${e.message}`);
        }
      }
    } catch (e) {
      failed.push({ item, reason: e.message });
    }
  }

  return { created, merged, failed };
}

export async function grow(textOrTurns, options = {}) {
  let turns;
  if (typeof textOrTurns === 'string') {
    turns = [{ role: 'user', content: textOrTurns }];
  } else if (Array.isArray(textOrTurns)) {
    turns = textOrTurns;
  } else {
    throw new Error('[extractor] grow: input must be a string or an array of turns');
  }

  try {
    const items = await dehydrator.dehydrate(turns);
    return await hold(items, { ...options, sourceTurns: turns });
  } catch (e) {
    const pending = {
      id: generatePendingId(),
      turns,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writePending(pending);
    return { created: [], merged: [], failed: [], pending: [{ id: pending.id }] };
  }
}

export async function growStructured(items, options = {}) {
  const validItems = [];
  const failed = [];

  for (const item of items) {
    const normalized = dehydrator.validateAndNormalizeItem(item, Number.MAX_SAFE_INTEGER);
    if (normalized) {
      validItems.push(normalized);
    } else {
      failed.push({ item, reason: 'invalid item' });
    }
  }

  const result = await hold(validItems, options);
  result.failed.push(...failed);
  return result;
}

export async function sweepPending(options = {}) {
  const maxBatch = options.maxBatch ?? 5;
  const maxAttempts = options.maxAttempts ?? 3;
  const pendingDir = path.join(getConfig().paths.memoriesDirAbs, 'pending');

  let files;
  try {
    files = await fs.readdir(pendingDir);
  } catch (e) {
    if (e.code === 'ENOENT') return { retried: 0, succeeded: 0, failed: [] };
    throw e;
  }

  const pendingFiles = files
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(0, maxBatch);

  let retried = 0;
  let succeeded = 0;
  const failed = [];

  for (const file of pendingFiles) {
    const filePath = path.join(pendingDir, file);
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch (e) {
      console.warn(`[extractor] failed to read pending file ${file}: ${e.message}`);
      continue;
    }

    const attempts = raw.attempts || 0;
    if (attempts >= maxAttempts) {
      const failedDir = path.join(pendingDir, 'failed');
      await fs.mkdir(failedDir, { recursive: true });
      await fs.rename(filePath, path.join(failedDir, file));
      failed.push({ id: raw.id, attempts, error: 'max attempts exceeded' });
      continue;
    }

    retried++;

    try {
      let result;
      if (raw.turns && Array.isArray(raw.turns)) {
        const items = await dehydrator.dehydrate(raw.turns);
        result = await hold(items, { sourceTurns: raw.turns });
        if (result.failed.length > 0 && (result.created.length > 0 || result.merged.length > 0)) {
          raw.items = result.failed.map(f => f.item);
          delete raw.turns;
        }
      } else if (raw.items && Array.isArray(raw.items)) {
        result = await hold(raw.items, raw.options || {});
        if (result.failed.length > 0 && (result.created.length > 0 || result.merged.length > 0)) {
          raw.items = result.failed.map(f => f.item);
        }
      } else {
        throw new Error('unknown pending type');
      }

      if (result.failed.length > 0) {
        raw.attempts = attempts + 1;
        raw.updatedAt = new Date().toISOString();
        await fs.writeFile(filePath, JSON.stringify(raw, null, 2));
        failed.push({ id: raw.id, attempts: raw.attempts, error: `partial failure: ${result.failed.length} items failed` });
      } else {
        await fs.unlink(filePath);
        succeeded++;
      }
    } catch (e) {
      raw.attempts = attempts + 1;
      raw.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath, JSON.stringify(raw, null, 2));
      failed.push({ id: raw.id, attempts: raw.attempts, error: e.message });
    }
  }

  return { retried, succeeded, failed };
}
