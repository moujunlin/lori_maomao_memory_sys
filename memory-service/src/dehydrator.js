// ============================================================
// 模块：dehydrator（脱水/记忆提取）
// 职责：接收对话轮次，调用 LLM 产出结构化提取建议
// 不写入磁盘、不管触发时机、不做 fallback（调用方负责）
// ============================================================

import { createHash } from 'node:crypto';
import { callRealtime } from './llm_client.js';
import { getConfig } from '../config.js';

const SYSTEM_PROMPT = `你是对话记忆提取助手。分析用户提供的对话轮次，提取值得长期保存的记忆片段。

【提取标准】只提取有长期价值的内容：
1. 事实性信息：用户的生活事件、偏好、习惯变化
2. 情绪峰值：明显的情绪波动（焦虑、开心、哭泣、感动、愤怒等）
3. 关系性内容：新的认知、承诺、关系里程碑、信任变化
4. 技术决策：项目相关的架构决定、问题解决方案
不提取：纯寒暄、重复信息、无实质内容的闲聊

【分类规则】
- 核心是情绪体验或情感状态变化 → type: "feel"
- 核心是事件或信息 → type: "memory"
- 同一段对话可以同时产出 feel 和 memory

【输出要求】
输出合法 JSON 数组，不要 markdown 代码块，不要解释文字。空数组 [] 表示无值得提取的内容。

每项字段约束：
- type: "memory" | "feel"
- summary: 字符串，简洁准确的记忆内容，不超过100字
- tags: 字符串数组，无标签时传 []
- importance: 数字，1.0~10.0（实数），越高越重要
- sourceRange: { start: 整数, end: 整数 }，引用对话轮次索引（0-based，闭区间）。单轮时 start === end。
- emotion: 仅 type 为 "feel" 时需要。格式 { label: 字符串, valence: -1.0~1.0, arousal: 0.0~1.0 }
  - label: 简短情绪标签，如"焦虑"、"开心"
  - valence: 效价，-1 极负面，1 极正面
  - arousal: 唤醒度，0 平静，1 极度兴奋`;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

function formatTurns(turns) {
  const lines = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!ALLOWED_ROLES.has(t.role)) {
      console.warn(`[dehydrator] 跳过非法 role: ${t.role}`);
      continue;
    }
    // 转义 content 中可能破坏 XML/文本边界的 < >
    const safeContent = String(t.content ?? '').replace(/</g, '\\<').replace(/>/g, '\\>');
    lines.push(`[${i}] ${t.role}: ${safeContent}`);
  }
  return lines.join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function isValidNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanJsonContent(content) {
  const s = content.trim();
  if (s.startsWith('```')) {
    const end = s.lastIndexOf('```');
    if (end > 3) {
      return s.slice(s.indexOf('\n') + 1, end).trim();
    }
  }
  return s;
}

function validateAndNormalizeItem(item, turnCount) {
  if (!item || typeof item !== 'object') {
    console.warn('[dehydrator] 丢弃非对象项');
    return null;
  }

  const type = item.type;
  if (type !== 'memory' && type !== 'feel') {
    console.warn(`[dehydrator] 丢弃非法 type 项: ${type}`);
    return null;
  }

  if (typeof item.summary !== 'string' || item.summary.trim().length === 0) {
    console.warn('[dehydrator] 丢弃缺失或空 summary 项');
    return null;
  }

  if (!Array.isArray(item.tags)) {
    console.warn('[dehydrator] 丢弃非法 tags 项');
    return null;
  }
  const tags = item.tags.filter((t) => typeof t === 'string');

  if (!isValidNumber(item.importance)) {
    console.warn(`[dehydrator] 丢弃非法 importance 项: ${item.importance}`);
    return null;
  }
  const importance = clamp(item.importance, 1, 10);
  if (importance !== item.importance) {
    console.warn(`[dehydrator] importance 越界已 clamp: ${item.importance} → ${importance}`);
  }

  const sr = item.sourceRange;
  if (!sr || typeof sr !== 'object' || !isValidNumber(sr.start) || !isValidNumber(sr.end)) {
    console.warn('[dehydrator] 丢弃非法 sourceRange 项');
    return null;
  }
  const start = Math.floor(sr.start);
  const end = Math.floor(sr.end);
  if (start < 0 || end >= turnCount || start > end) {
    console.warn(`[dehydrator] 丢弃越界 sourceRange 项: [${start}, ${end}]，有效范围 [0, ${turnCount - 1}]`);
    return null;
  }

  const result = {
    type,
    summary: item.summary.trim(),
    tags,
    importance,
    sourceRange: { start, end },
  };

  if (type === 'feel') {
    const em = item.emotion;
    if (!em || typeof em !== 'object' || typeof em.label !== 'string' || !isValidNumber(em.valence) || !isValidNumber(em.arousal)) {
      console.warn('[dehydrator] 丢弃 feel 缺失 emotion 项');
      return null;
    }
    const valence = clamp(em.valence, -1, 1);
    const arousal = clamp(em.arousal, 0, 1);
    if (valence !== em.valence) {
      console.warn(`[dehydrator] emotion.valence 越界已 clamp: ${em.valence} → ${valence}`);
    }
    if (arousal !== em.arousal) {
      console.warn(`[dehydrator] emotion.arousal 越界已 clamp: ${em.arousal} → ${arousal}`);
    }
    result.emotion = {
      label: em.label.trim(),
      valence,
      arousal,
    };
  }

  return result;
}

// 同内容并发调用共享一次 LLM 请求
const _inFlight = new Map();

export async function dehydrate(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return [];
  }

  const maxTurns = getConfig().dehydrator?.maxTurns ?? 50;
  if (turns.length > maxTurns) {
    throw new Error(`[dehydrator] turns 数量(${turns.length})超过上限(${maxTurns})，请由调用方截断`);
  }

  // 过滤 system turns，保留原始索引映射，使返回的 sourceRange 指向输入数组
  const originalIndexMap = [];
  const dialogueTurns = [];
  for (let i = 0; i < turns.length; i++) {
    if (ALLOWED_ROLES.has(turns[i].role)) {
      originalIndexMap.push(i);
      dialogueTurns.push(turns[i]);
    }
  }

  const key = sha256(JSON.stringify(dialogueTurns));
  const existing = _inFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const userContent = `<dialogue>\n${formatTurns(dialogueTurns)}\n</dialogue>`;
    const res = await callRealtime({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    if (res.finishReason && res.finishReason !== 'stop') {
      console.warn(`[dehydrator] LLM 响应未完成: finishReason=${res.finishReason}, length=${res.content?.length ?? 0}`);
      throw new Error(`[dehydrator] LLM 响应未完成: finishReason=${res.finishReason}`);
    }

    const raw = cleanJsonContent(res.content);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn(`[dehydrator] JSON 解析失败: ${e.message}, rawLength=${raw.length}`);
      throw new Error(`[dehydrator] JSON 解析失败: ${e.message}`);
    }

    if (!Array.isArray(parsed)) {
      console.warn(`[dehydrator] 响应根值不是数组, rawLength=${raw.length}`);
      throw new Error(`[dehydrator] 响应根值不是数组`);
    }

    const results = [];
    for (const item of parsed) {
      const normalized = validateAndNormalizeItem(item, dialogueTurns.length);
      if (normalized) {
        normalized.sourceRange = {
          start: originalIndexMap[normalized.sourceRange.start],
          end: originalIndexMap[normalized.sourceRange.end],
        };
        results.push(normalized);
      }
    }

    return results;
  })();

  _inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    _inFlight.delete(key);
  }
}
