// ============================================================
// 模块：统一配置（memory-service 全局单例）
// 优先级：环境变量 > config.json > DEFAULTS
// 对应 CLAUDE.md「配置项不硬编码，统一走 config」
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ========== 默认配置 ==========
// 所有常量集中于此；数值严格对齐 CLAUDE.md 和 Ombre-Brain 参考项目
export const DEFAULTS = {
  // --- HTTP 服务 ---
  server: { host: '127.0.0.1', port: 3555 },

  // --- 存储路径（相对 memory-service 根目录，运行时会解析为绝对路径） ---
  paths: {
    memoriesDir: 'memories',
    subdirs: { dynamic: 'dynamic', archived: 'archived', feel: 'feel' },
    cacheDir: 'cache',
    cacheDbFile: 'dehydration.db',
  },

  // --- LLM 双通道（OpenAI 兼容协议） ---
  // realtime：小/快模型，每轮对话后 analyze(打标) + dehydrate(压缩)，高频低延迟
  // review  ：主/强模型（通常与聊天同款），merge(合并) + dream review hint + 周期回顾
  // fallback 方向：realtime 缺项 → 回退到 review（review 是聊天主模型，总是配好的；realtime 才常被省略）
  // temperature: null 表示请求时不传该参数，适配禁止 temperature 的模型（如 claude-opus-4-7）
  llm: {
    realtime: {
      baseUrl: '',     // 留空则 fallback 到 review.baseUrl
      apiKey: '',      // 留空则 fallback 到 review.apiKey，并打印 warn
      model: '',       // 留空则 fallback 到 review.model
      maxTokens: 1024,
      temperature: null,
      timeoutMs: 60000,
    },
    review: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      maxTokens: 2048,
      temperature: null,
      timeoutMs: 120000,
    },
  },

  // --- 衰减引擎（对应 decay_engine.py） ---
  decay: {
    lambda: 0.05,                 // 衰减速率
    threshold: 0.3,               // 低于此分数归档
    checkIntervalHours: 24,       // 后台扫描周期
    shortTermDays: 3,             // 短/长期分界
    activationExponent: 0.3,      // activation_count^0.3
    emotionWeights: { base: 1.0, arousalBoost: 0.8 },   // 1.0 + 0.8×arousal
    freshness: { base: 1.0, coef: 1.0, tauHours: 36 },  // 1.0 + 1.0×e^(-h/36)
    resolvedFactor: 0.05,         // resolved 桶衰减×0.05
    digestedFactor: 0.02,         // resolved + digested 桶衰减×0.02
    urgencyArousalThreshold: 0.7, // arousal > 0.7 且 unresolved → urgency
    urgencyBoost: 1.5,
    pinnedScore: 999,             // pinned/protected/permanent 固定分
    feelScore: 50,                // feel 桶固定分，不衰减
    autoResolve: { importanceMax: 4, daysMin: 30 },  // imp≤4 且 >30 天自动结案
  },

  merge: { threshold: 75 },   // 相似度 ≥75 合并
  matching: { fuzzyThreshold: 50, maxResults: 5 },
  scoring: { topic: 4.0, emotion: 2.0, time: 1.5, importance: 1.0, content: 1.0 },

  // --- Dream ---
  // review  ：对话启动时的回顾消化（当前 dream() 实际行为——读最近N条 + connection/crystal hint）
  // trueDream：真正的自由联想做梦（v1 关闭，仅预留结构；未来在空闲/夜间时段异步触发）
  dream: {
    review: {
      recentLimit: 10,
      connectionSimThreshold: 0.5,
      crystalSimThreshold: 0.7,
      crystalMinFeels: 3,
      crystalMinSimilarPeers: 2,
      contentPreviewChars: 500,
    },
    trueDream: {
      enabled: false,
      seedCount: { min: 1, max: 5 },
      recallK: 12,
      maxRangeDays: 180,
      timeWindow: { startHour: 2, endHour: 6 },
      probability: 0.6,
      requireApproval: true,
    },
  },

  reconstruction: { valenceDrift: 0.1 },  // 检索时 valence 展示值微调幅度
  embedding: { enabled: false, baseUrl: '', apiKey: '', model: 'gemini-embedding-001' },  // v1 关闭
  timeRipple: { windowHours: 48, maxRippled: 5, boost: 0.3 },  // 联想激活：相邻桶 activation_count 微提
  log: { level: 'info' },
};

// ========== 深合并（仅合并普通对象，数组直接替换） ==========
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    const v = source[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[key] = deepMerge(target[key] ? { ...target[key] } : {}, v);
    } else if (v !== undefined) {
      target[key] = v;
    }
  }
  return target;
}

// ========== 环境变量覆盖（仅关键字段，尤其 apiKey 强烈建议走 env） ==========
function applyEnvOverrides(cfg) {
  const env = process.env;
  const set = (v, fn) => { if (v !== undefined && v !== '') fn(v); };
  set(env.MEMORY_PORT, v => cfg.server.port = Number(v));
  set(env.MEMORY_HOST, v => cfg.server.host = v);
  for (const chan of ['realtime', 'review']) {
    const U = chan.toUpperCase();
    set(env[`MEMORY_LLM_${U}_KEY`],      v => cfg.llm[chan].apiKey = v);
    set(env[`MEMORY_LLM_${U}_BASE_URL`], v => cfg.llm[chan].baseUrl = v);
    set(env[`MEMORY_LLM_${U}_MODEL`],    v => cfg.llm[chan].model = v);
  }
  set(env.MEMORY_MEMORIES_DIR, v => cfg.paths.memoriesDir = v);
  set(env.LOG_LEVEL, v => cfg.log.level = v);
  return cfg;
}

// ========== Realtime 通道 fallback ==========
// realtime 缺 apiKey/baseUrl/model 时回退到 review；apiKey 回退时打印 warn
function applyRealtimeFallback(cfg) {
  const rt = cfg.llm.realtime;
  const r = cfg.llm.review;
  if (!rt.apiKey && r.apiKey) {
    console.warn('[config] realtime 通道未配置 apiKey，回退使用 review.apiKey；建议单独配置小/快模型以节省成本');
    rt.apiKey = r.apiKey;
  }
  if (!rt.baseUrl) rt.baseUrl = r.baseUrl;
  if (!rt.model) rt.model = r.model;
  return cfg;
}

// ========== 路径解析（相对路径 → 绝对路径，供下游模块直接使用） ==========
function resolvePaths(cfg, rootDir) {
  const absRoot = path.resolve(rootDir);
  const p = cfg.paths;
  p.rootDirAbs = absRoot;
  p.memoriesDirAbs = path.resolve(absRoot, p.memoriesDir);
  p.cacheDirAbs = path.resolve(absRoot, p.cacheDir);
  p.cacheDbPathAbs = path.join(p.cacheDirAbs, p.cacheDbFile);
  return cfg;
}

// ========== 基本校验（只 warn 不抛错，保证进程能起来） ==========
function validate(cfg) {
  const errs = [];
  if (!cfg.llm.review.apiKey) errs.push('llm.review.apiKey 未配置（主模型密钥，可用环境变量 MEMORY_LLM_REVIEW_KEY 注入）');
  if (cfg.decay.threshold < 0) errs.push('decay.threshold 不能为负');
  if (cfg.merge.threshold < 0 || cfg.merge.threshold > 100) errs.push('merge.threshold 应在 0~100');
  if (errs.length) console.warn('[config] 校验警告:\n  - ' + errs.join('\n  - '));
  return cfg;
}

// ========== 主入口 ==========
let _cached = null;

export function loadConfig({ configPath, rootDir = __dirname } = {}) {
  const cfg = deepMerge({}, structuredClone(DEFAULTS));

  const filePath = configPath || path.join(rootDir, 'config.json');
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      deepMerge(cfg, raw);
    } catch (e) {
      console.error(`[config] 读取 ${filePath} 失败，使用默认配置: ${e.message}`);
    }
  }

  applyEnvOverrides(cfg);
  applyRealtimeFallback(cfg);
  resolvePaths(cfg, rootDir);
  validate(cfg);

  _cached = cfg;
  return cfg;
}

export function getConfig() {
  return _cached || loadConfig();
}

export function resetConfig() {
  _cached = null;
}
