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
    subdirs: { dynamic: 'dynamic', archived: 'archived', feel: 'feel', notebook: 'notebook' },
    partnerNotesDir: 'partner_notes',
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
    feelLambda: 0.02,             // feel 专用衰减速率（慢于普通记忆的 0.05）
    feelBaseScore: 30,            // feel 初始分基数
    feelArousalMultiplier: 40,    // arousal 加权系数，范围约 30~70
    autoResolve: { importanceMax: 4, daysMin: 30 },  // imp≤4 且 >30 天自动结案
  },

  merge: { threshold: 75 },   // 相似度 ≥75 合并
  matching: { fuzzyThreshold: 50, maxResults: 5 },
  scoring: { topic: 4.0, emotion: 2.0, time: 1.5, importance: 1.0, content: 1.0 },

  // --- Recall（对话启动回顾，轻量） ---
  // 对话流前置步骤，不是独立定时任务；仅在与上次对话间隔过长时触发
  // 职责：浮现近期记忆 / 近期 feel / 未 resolve 情绪，读 notebook，注入时间感知
  // 不做：桶合并、归档、notebook 清理、profile suggestion（这些归 review）
  recall: {
    gapThresholdMinutes: 60,       // 对话间隔超过多久触发 recall
    recentLimit: 10,               // 浮现最近 N 条记忆
    includeUnresolved: true,       // 拉未 resolve 的情绪记忆
    includeRecentFeels: true,      // 拉近期 feel
    feelLimit: 5,                  // 最多拉几条 feel
  },

  // --- DailyReview（每日回顾，重量级） ---
  // daily 定时任务 + 手动 trigger（/review endpoint），系统性回顾整合
  // 命名 dailyReview 而非 review 是为了和 llm.review 通道彻底解耦
  dailyReview: {
    connectionSimThreshold: 0.5,
    crystalSimThreshold: 0.7,
    crystalMinFeels: 3,
    crystalMinSimilarPeers: 2,
    contentPreviewChars: 500,
    scheduledOffsetMinutes: 5,     // 在 notebook.dailyResetHour 之后几分钟执行（默认 05:05）；改 dailyResetHour 时自动跟随
  },

  // --- TrueDream（v1 关闭，预留） ---
  // 独立于对话流的自由联想，在空闲/夜间时段异步触发
  trueDream: {
    enabled: false,
    seedCount: { min: 1, max: 5 },
    recallK: 12,
    maxRangeDays: 180,
    timeWindow: { startHour: 2, endHour: 6 },
    probability: 0.6,
    requireApproval: true,
  },

  // --- Notebook（置顶备忘，每次对话启动注入，不走检索不走衰减） ---
  notebook: {
    filename: 'notebook.md',          // 相对 subdirs.notebook 目录
    maxItems: 50,                     // 超出时 review 阶段优先清理 done，其次合并 ongoing
    retainDoneForReviews: 1,          // done 条目保留几个 review 周期后删除
    dailyResetHour: 5,                // 每日几点重置 ongoing 子项 checkbox（0-23），不调用模型
  },

  cache: {
    hotBucketCapacity: 50,            // LRU 热桶缓存：最多保留 N 个解析后的桶
  },

  // --- Partner Notes（用户便利贴，v1 无额外配置项，预留空对象） ---
  partnerNotes: {},

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
// 绝对路径或 .. 逃逸到指定父目录外一律拒绝，启动阶段 fail fast，避免存储操作写到服务目录外
function assertInsideDir(absParent, absChild, fieldName) {
  if (absChild !== absParent && !absChild.startsWith(absParent + path.sep)) {
    throw new Error(
      `[config] ${fieldName} 解析后 (${absChild}) 不在允许目录 (${absParent}) 内，拒绝启动`
    );
  }
}

function resolvePaths(cfg, rootDir) {
  const absRoot = path.resolve(rootDir);
  const p = cfg.paths;
  p.rootDirAbs = absRoot;
  p.memoriesDirAbs = path.resolve(absRoot, p.memoriesDir);
  p.partnerNotesDirAbs = path.resolve(p.memoriesDirAbs, p.partnerNotesDir);
  p.cacheDirAbs = path.resolve(absRoot, p.cacheDir);
  p.cacheDbPathAbs = path.resolve(p.cacheDirAbs, p.cacheDbFile);
  assertInsideDir(absRoot, p.memoriesDirAbs, 'paths.memoriesDir');
  assertInsideDir(p.memoriesDirAbs, p.partnerNotesDirAbs, 'paths.partnerNotesDir');
  assertInsideDir(absRoot, p.cacheDirAbs, 'paths.cacheDir');
  // subdirs.* 以 memoriesDirAbs 为边界校验：防 config 手写错误（如 '../../outside'）
  // 让 bucket 写到 memoriesDir 外。permanent 是硬编码不走 subdirs，无需校验
  if (p.partnerNotesDirAbs === p.memoriesDirAbs) {
    throw new Error(
      `[config] paths.partnerNotesDir (${p.partnerNotesDir}) 不能为 memoriesDir 本身，拒绝启动`
    );
  }
  for (const [key, dirName] of Object.entries(p.subdirs || {})) {
    const abs = path.resolve(p.memoriesDirAbs, dirName);
    assertInsideDir(p.memoriesDirAbs, abs, `paths.subdirs.${key}`);
    if (abs === p.partnerNotesDirAbs) {
      throw new Error(
        `[config] paths.partnerNotesDir (${p.partnerNotesDir}) 与 paths.subdirs.${key} (${dirName}) 重叠，拒绝启动`
      );
    }
    const rel = path.relative(p.partnerNotesDirAbs, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(
        `[config] paths.partnerNotesDir (${p.partnerNotesDir}) 包含 paths.subdirs.${key} (${dirName})，拒绝启动`
      );
    }
    const rel2 = path.relative(abs, p.partnerNotesDirAbs);
    if (!rel2.startsWith('..') && !path.isAbsolute(rel2)) {
      throw new Error(
        `[config] paths.partnerNotesDir (${p.partnerNotesDir}) 位于 paths.subdirs.${key} (${dirName}) 内，拒绝启动`
      );
    }
  }
  // permanent 是硬编码目录，不在 subdirs 循环中，单独校验重叠
  const permanentAbs = path.resolve(p.memoriesDirAbs, 'permanent');
  const relPerm = path.relative(p.partnerNotesDirAbs, permanentAbs);
  if (!relPerm.startsWith('..') && !path.isAbsolute(relPerm)) {
    throw new Error(
      `[config] paths.partnerNotesDir (${p.partnerNotesDir}) 包含 permanent 目录，拒绝启动`
    );
  }
  const relPerm2 = path.relative(permanentAbs, p.partnerNotesDirAbs);
  if (!relPerm2.startsWith('..') && !path.isAbsolute(relPerm2)) {
    throw new Error(
      `[config] paths.partnerNotesDir (${p.partnerNotesDir}) 位于 permanent 目录内，拒绝启动`
    );
  }
  // cacheDbFile 以 cacheDirAbs 为边界校验：即使 cacheDir 合法，DB 文件名也可能用 .. 逃出去
  assertInsideDir(p.cacheDirAbs, p.cacheDbPathAbs, 'paths.cacheDbFile');
  // 防御 cacheDbFile 解析为空串/'.'/'subdir/..' 时落回 cacheDirAbs 本身；下游按文件打开会挂，早挂早诊断
  if (p.cacheDbPathAbs === p.cacheDirAbs) {
    throw new Error(
      `[config] paths.cacheDbFile 解析后等于 cacheDirAbs (${p.cacheDirAbs})，必须是一个文件路径，拒绝启动`
    );
  }
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
