// ============================================================
// 模块：LLM 客户端（OpenAI 兼容协议，双通道传输层）
// 职责：HTTP 调用 + 超时 + 错误分类 + usage 统计；不碰业务
// 上层（dehydrator / dream / extractor）拼 messages 传入，拿回纯文本
// 不负责：prompt 模板、JSON 解析、缓存、重试（这些是业务语义）
// ============================================================

import { getConfig } from '../config.js';

// ========== 错误类型 ==========
// kind 分类（上层按 kind 决定降级策略）：
//   auth            401/403，key 错/过期；上层放弃并报警
//   rate_limit      429；上层可按 retry-after 延迟重试
//   context_length  4xx 且 message 含上下文超长关键词；上层可截断重发
//   response        其他 4xx / 响应结构异常 / JSON 解析失败；上层通常放弃
//   transport       网络错误 / 5xx / DNS / reset；上层可重试
//   timeout         本地超时（fetch abort）；上层可重试
export class LlmError extends Error {
  constructor(message, { channel, kind, status = null, retryAfter = null, cause = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.channel = channel;
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;  // 秒数；仅 429/503 且响应带 Retry-After 头时有值
    if (cause) this.cause = cause;
  }
}

// ========== 错误分类 ==========

// 上下文超长关键词。不同厂商 message 格式五花八门，用正则兜底匹配
// 覆盖：OpenAI/DeepSeek/Claude 英文表述 + 通义/GLM 中文表述
const CONTEXT_LENGTH_PATTERNS = [
  /context[_ ]length/i,
  /context[_ ]window/i,
  /max[_ ]?tokens?/i,
  /too[_ ]long/i,
  /exceeds?.*(?:limit|maximum)/i,
  /too many tokens/i,
  /input.*too.*large/i,
  /输入.*过长/,
  /超出.*长度/,
  /上下文.*过长/,
  /请求内容过长/,
];

function isContextLengthError(text) {
  if (!text) return false;
  return CONTEXT_LENGTH_PATTERNS.some((re) => re.test(text));
}

// 按 status + body 文本分类 HTTP 错误
function classifyHttpError(status, bodyText) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if ((status === 400 || status === 422) && isContextLengthError(bodyText)) return 'context_length';
  if (status >= 500) return 'transport';
  return 'response';
}

// ========== 请求构造 ==========

// OpenAI 兼容 /chat/completions 请求体
// temperature: null → 不传（适配禁止该参数的模型，如 claude-opus-4-7）
function buildRequestBody(channelCfg, opts) {
  const body = {
    model: channelCfg.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? channelCfg.maxTokens,
  };
  const temp = opts.temperature ?? channelCfg.temperature;
  if (temp !== null && temp !== undefined) body.temperature = temp;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (opts.stop) body.stop = opts.stop;
  return body;
}

// 本地超时 signal；返回 { signal, cleanup }
function makeTimeout(timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return { signal: ctrl.signal, cleanup: () => clearTimeout(timer) };
}

// 截断长文本（日志/错误信息避免把整个响应体打出来）
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// 解析 Retry-After 头（仅支持秒数形式；HTTP-date 形式极少见，v1 忽略返回 null）
function parseRetryAfter(header) {
  if (!header) return null;
  const n = parseInt(header, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ========== 主入口 ==========

// channel: 'realtime' | 'review'
// opts:
//   messages        必填，OpenAI 格式 [{ role, content }, ...]
//   maxTokens       可选，覆盖 config 通道默认
//   temperature     可选，覆盖 config；传 null 表示请求时不传该字段
//   responseFormat  可选，透传给 OpenAI 兼容端（如 { type: 'json_object' }）；
//                   不保证所有后端支持，JSON 解析由上层自行兜底
//   stop            可选，stop sequences
// 返回：{ content, finishReason, usage, model, latencyMs }
//   usage = { promptTokens, completionTokens, totalTokens }（厂商不返回时为 null）
export async function callLlm(channel, opts) {
  if (channel !== 'realtime' && channel !== 'review') {
    throw new LlmError(`未知通道: ${channel}`, { channel, kind: 'response' });
  }
  if (!Array.isArray(opts?.messages) || opts.messages.length === 0) {
    throw new LlmError('messages 必须是非空数组', { channel, kind: 'response' });
  }

  const cfg = getConfig();
  const ch = cfg.llm[channel];
  if (!ch.apiKey) {
    throw new LlmError(`${channel} 通道 apiKey 未配置`, { channel, kind: 'auth' });
  }

  const url = `${ch.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = buildRequestBody(ch, opts);
  const { signal, cleanup } = makeTimeout(ch.timeoutMs);
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ch.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    cleanup();
    const kind = e?.name === 'AbortError' ? 'timeout' : 'transport';
    throw new LlmError(`[llm:${channel}] 请求失败: ${e.message}`, { channel, kind, cause: e });
  }

  let text;
  try {
    text = await res.text();
  } catch (e) {
    cleanup();
    throw new LlmError(`[llm:${channel}] 读取响应失败: ${e.message}`, {
      channel, kind: 'transport', status: res.status, cause: e,
    });
  }
  cleanup();

  if (!res.ok) {
    const kind = classifyHttpError(res.status, text);
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    throw new LlmError(`[llm:${channel}] HTTP ${res.status}: ${truncate(text, 300)}`, {
      channel, kind, status: res.status, retryAfter,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new LlmError(`[llm:${channel}] 响应非 JSON: ${truncate(text, 200)}`, {
      channel, kind: 'response', status: res.status, cause: e,
    });
  }

  const choice = parsed?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmError(`[llm:${channel}] 响应缺少 choices[0].message.content`, {
      channel, kind: 'response', status: res.status,
    });
  }

  const latencyMs = Date.now() - startedAt;
  const usage = {
    promptTokens: parsed.usage?.prompt_tokens ?? null,
    completionTokens: parsed.usage?.completion_tokens ?? null,
    totalTokens: parsed.usage?.total_tokens ?? null,
  };

  console.log(
    `[llm] channel=${channel} model=${ch.model} latency=${latencyMs}ms ` +
    `tokens=${usage.promptTokens ?? '?'}/${usage.completionTokens ?? '?'}`
  );

  return {
    content,
    finishReason: choice?.finish_reason ?? null,
    usage,
    model: ch.model,
    latencyMs,
  };
}

// ========== 语法糖 ==========
export const callRealtime = (opts) => callLlm('realtime', opts);
export const callReview = (opts) => callLlm('review', opts);
