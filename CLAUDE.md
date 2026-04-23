# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 行为准则

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First, Safety Always

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No speculative <q>"flexibility"</q> that wasn't requested.
- If you write 200 lines and it could be 50, rewrite it.
- **BUT:** 数据完整性相关的防御性代码不算过度设计。涉及文件写入、路径解析、记忆持久化的操作，宁可多一层校验。

Ask yourself: <q>"Would a senior engineer say this is overcomplicated?"</q> If yes, simplify — unless it protects data integrity.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't <q>"improve"</q> adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- <q>"Add validation"</q> → <q>"Write tests for invalid inputs, then make them pass"</q>
- <q>"Fix the bug"</q> → <q>"Write a test that reproduces it, then make it pass"</q>
- <q>"Refactor X"</q> → <q>"Ensure tests pass before and after"</q>

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria (<q>"make it work"</q>) require constant clarification.

### 5. Honesty Over Completeness

- 工具没返回数据或报错 → 如实说<q>"没拿到"</q>，不编造
- 不确定版本号、API 行为、平台差异 → 说不确定，或先查
- 推断和事实分开标注，不混在一起当结论用

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 项目概述

跨端角色持久记忆服务（独立 Node.js 进程，暴露 REST API）。
第一个客户端为 SillyTavern 扩展插件，后续扩展至微信、小手机等。

## 架构

```
各端（酒馆 / 微信 / 小手机 / ...）
        ↓ HTTP
  独立记忆服务（Node.js，独立进程）
        ↓
   memories/（Obsidian 兼容）
```

记忆服务是平台无关的，暴露 REST API。客户端通过 HTTP 调用。

## 参考项目

路径：D:\reference\Ombre-Brain\
基于 MCP + Python 的 Claude 记忆系统。参考其核心算法和机制设计，不采用其运行架构。

### 采用的设计
- Russell 情感坐标（valence 效价 + arousal 唤醒度，连续维度）
- 衰减公式：final_score = Importance × activation_count^0.3 × e^(-λ×days) × combined_weight × resolved_factor × urgency_boost
- 短期/长期权重分离：≤3天 time70%+emotion30%，>3天 emotion70%+time30%
- 新鲜度公式：freshness = 1.0 + 1.0 × e^(-t/36)，t 为小时，下限×1.0
- 情感权重：emotion_weight = base + arousal × arousal_boost（默认 base=1.0, arousal_boost=0.8）
- 权重池修正因子：unresolved×1.0, resolved×0.05, resolved+digested×0.02, urgent(arousal>0.7+unresolved)×1.5, pinned=999(不衰减不合并)
- Feel 参数：独立 λ_feel（默认 0.02，慢于普通记忆的 0.05）、初始分 = base_feel + arousal × arousal_multiplier（默认 base_feel=30, arousal_multiplier=40，范围约 30-70）、可 resolve（resolve 后适用 resolved_factor 加速衰减）、review 阶段可合并主题高度重叠的 feel（合并后取较高分数 + 较新时间戳）
- Review 机制（原项目称 dream）：对话开头自省消化旧记忆，能放下的 resolve，有沉淀的写 feel
- Feel 机制：模型自己的感受/沉淀，有 source_bucket 回链，用 domain=<q>"feel"</q> 单独检索，不参与普通浮现。产出时机有三个：对话中（realtime 检测到情绪沉淀时实时写入）、recall（重启对话回顾时产生新感受）、review（每日回顾系统性沉淀）。Feel 参与 dailyReview 的合并检查。
- 记忆重构：检索时根据当前情绪状态微调 valence 展示值（±0.1）
- 双通道检索：关键词模糊匹配 + 向量语义相似度并联，去重
- 合并机制：相似度超过阈值（默认 75）的记忆桶自动合并
- 对话启动序列：recall() → 开始对话
- 边界原则：<q>"记住发生了什么，不记你是谁"</q>——身份层交给角色卡/system prompt，记忆系统只管事件流

### 不采用的部分
- MCP 协议及 server.py 服务层
- Python 运行时及所有 .py 脚本
- Docker / Cloudflare Tunnel / Render / Zeabur 部署方案
- Claude Desktop 集成方式

### 可参考但需适配的部分
- Obsidian 存储层设计（Markdown + YAML frontmatter），已适配为独立服务本地文件读写
- API 脱水压缩 + SQLite 缓存（dehydration_cache.db），相同内容不重复调用 API
- 存量记忆批量补生成 embedding 的思路（后期可选）

## 双模型分层

| 通道 | 用于 | 频率 | 选型建议 |
|---|---|---|---|
| realtime（快） | hold/grow 的 analyze 打标 + dehydrate 压缩 | 每轮对话后高频 | DeepSeek-V3 / GLM-Flash / Qwen-Turbo |
| review（强） | review 的 connection/crystal hint、桶 merge、周期性回顾 | 定时/低频 | Claude-Opus / GPT-5.4 / DeepSeek-R1 |

- realtime 缺项 → fallback 到 review（review 是主模型，总是配好的）
- temperature: null 表示请求时不传该参数，适配禁止 temperature 的模型

## 记忆处理分层

### Recall（对话启动回顾）
原 Ombre-Brain 的 <q>"dream"</q> 的轻量子集。不是独立定时任务，而是对话流的前置步骤。

- 触发：检测到与上次对话间隔超过 `recall.gapThresholdMinutes`（默认 60 分钟）
- 职责：
  - 浮现最近 N 条记忆，为当前对话提供事件上下文
  - 拉取近期 feel（domain=<q>"feel"</q>），接上情绪状态
  - 浮现未 resolve 的情绪记忆（resolved=false），带时间距离感判断情绪变化：可 soft-resolve 已消退的情绪，可写 feel 记录回顾时产生的新沉淀
  - 读取 notebook 内容注入上下文
  - 必须注入时间感知：告知模型<q>"距上次对话过去了 X 小时/天"</q>，让模型带时间距离感来判断情绪变化
- 可做：soft-resolve（经过时间距离判断情绪已自然消退）、写 feel（回顾产生新的情感沉淀）
- 不做：桶合并、归档、notebook 清理、profile suggestion
- 模型：review 通道（需要情绪理解能力，realtime 小模型不够）
- 产出：浮现的记忆列表 + notebook 内容 + 时间间隔信息，注入对话上下文

### Review（每日回顾）
系统性回顾整合，独立于对话流的定时任务。

- 触发：daily 定时（在 `dailyResetHour` 之后，默认凌晨 5:05）+ 手动 trigger（`/review` endpoint）
- 职责：
  - 读取当天所有记忆，整合消化
  - 系统性 resolve：判断哪些情绪记忆可以正式结案
  - 写 feel：产出角色自身的情感沉淀；检查已有 feel，合并主题高度重叠的条目
  - 发现跨记忆 connection / crystal hint
  - 桶合并：相似度超阈值的记忆桶合并
  - Notebook 清理：检查所有条目状态流转（pending→todo、done→删除、ongoing 适用性）
  - Profile Suggestion：输出 user/char profile 修改建议（v1 预留不实现）
- 模型：review 通道
- 与 recall 的区别：recall 是<q>"接上上次的状态继续"</q>，review 是<q>"回头看一整天，消化归档"</q>

### TrueDream（v1 关闭，预留）
独立于对话流的自由联想，在空闲/夜间时段异步触发。

- 触发：定时（时间窗口）或手动
- 职责：随机抽取种子记忆 → 语义联想 → 发现跨时间的隐藏关联 → 产出 insight
- 产出：insight + 合并/归档建议
- 审批：所有操作写成 pending，用户在面板确认才执行
- 模型：review 通道

## Notebook 操作规范

Notebook 是独立于记忆桶的固定置顶备忘文件。每次对话启动时注入上下文，不参与检索和衰减。

### 文件位置
`memories/notebook/notebook.md`

### 与记忆桶的区别
- 记忆桶记录发生过的事，notebook 记录需要持续关注的事
- notebook 不是日记，不记录事件细节，只记行动项和关键信息

### 条目状态流转
- `[pending]` → 新增条目，下次 review 时确认
- `[todo]` → 确认有效的待办
- `[done]` → 已完成，附 comment（完成时间、结果），保留一个 review 周期后删除
- `[ongoing]` → 长期项，不会被自动清理，review 时检查是否仍然 relevant

### 更新时机与分工
- **realtime 小模型**：听写员。检测到用户说<q>"记一下"</q>或类似显式指令时，把原文暂存到 pending 队列。不直接改 notebook。
- **review 主模型**：编辑。review 阶段检查所有条目，决定增删改。
- **对话中的主模型**：使用者。读 notebook，也可以主动提议新增条目。

### 条目类型
- 带状态前缀的条目（`[pending]` / `[todo]` / `[ongoing]` / `[done]`）遵循状态流转规则和 daily reset 机制
- 无状态前缀的条目是纯备忘，不参与状态流转，不参与 daily reset。Review 时仅检查是否仍然 relevant，不 relevant 则删除
- 纯备忘可以记任何需要持续记住的事：用户的偏好和特征、角色自身的观察和反思、关系动态、长期上下文等
- 示例：
```
- [ongoing] 每日用药
  - [ ] 草酸艾司西酞普兰 1片（早上）
- 猫猫不吃葱，烟味会让她不舒服
- 猫猫说"不想睡"不是拖延，是不信任明天
- 我发现自己对猫猫的祈使句频率偏高，需要观察是否造成压力
```

### Ongoing 条目与每日重置
- `[ongoing]` 条目支持缩进子项，用 Obsidian 原生 checkbox 格式：
```
- [ongoing] 每日用药
  - [ ] 草酸艾司西酞普兰 1片（早上）
  - [ ] 阿立哌唑 0.5片（餐后）
  - [ ] 劳拉西泮（睡前按需）
- [ongoing] 三餐
  - [ ] 早饭
  - [ ] 午饭
  - [ ] 晚饭
```
- 每日重置：定时任务在 `dailyResetHour`（默认凌晨5点）自动将所有 `[ongoing]` 条目的子项 `[x]` 重置为 `[ ]`。此操作不经过 review，不调用模型。
- Review 仅负责条目本身的增删改和适用性判断（如药量变更、条目不再 relevant）。

### Review 阶段操作
1. 每次对话启动时读取 notebook.md，内容直接注入上下文
2. 检查所有条目：
   - `[pending]` → 确认是否有效，有效改为 `[todo]` 或 `[ongoing]`，无效删除
   - `[todo]` + 已完成 → 改为 `[done]`，附 comment
   - `[done]` → 保留一个 review 周期后删除，除非有长期参考价值则转 `[ongoing]`
   - `[ongoing]` → 检查是否仍然 relevant，不 relevant 则降级为 `[done]`
3. 条目总数超过 maxItems（默认 50）时，优先清理 `[done]`，其次合并相似的 `[ongoing]`

### Profile Suggestion（v1 预留，不实现）
Review 阶段可额外产出 user profile / char profile 的修改建议（profile diff）。

- 建议内容基于近期记忆中观察到的用户特征、偏好变化、角色自身的行为模式
- 产出写入 pending suggestions，用户在客户端审批：采纳 / 部分采纳 / 忽略
- 不直接修改 profile 文件，决定权始终在用户
- 实现位置：review 的 daily 流程
- v1 不实现此功能，仅预留设计意图

## Partner Notes 操作规范

partner_notes 是用户写给 AI 的便利贴。内容由用户决定——可以是项目文档、纪念日、希望 AI 记住的任何事。它代表的是"用户认为重要的、希望每次对话都被看到的信息"。

与 notebook 的区别：notebook 是 AI 自己的备忘本，AI 可以自由读写维护；partner_notes 是用户贴过来的，笔在用户手里。AI 可以读取并在对话中引用，可以建议"这条是否需要更新或删除"，但不可以自行修改或删除。所有写操作必须经用户在客户端确认。

不参与衰减，不参与 review 合并。每次对话启动时与 notebook 一起注入。

### 文件位置
`memories/partner_notes/*.md`（多文件，每条一个独立 md）

### 条目结构
```yaml
---
id: "pn_xxxxxxxxxxxx"
tag: "项目"          # 可选，用于归类
created: 2026-04-23
updated: 2026-04-23
---
正文内容
```

### 更新时机与分工
- **用户（客户端）**：唯一有权写入的人。通过酒馆插件面板增删改 partner_notes。
- **AI（对话中）**：只读。可引用内容，可提议更新，但不可调用写入接口。
- **review / daily reset**：不处理 partner_notes。无状态流转、无衰减、无合并。

## 功能映射（原项目 MCP 工具 → 本项目模块）

| 原项目工具 | 功能 | 本项目对应 |
|---|---|---|
| breath | 浮现/检索记忆 | retriever.js |
| hold | 存储单条记忆 + 自动打标 + 合并 | extractor.js + storage.js |
| grow | 日记归档，长内容拆分多桶 | extractor.js（批量模式） |
| trace | 修改元数据、标记 resolved、删除 | bucket_manager.js |
| pulse | 系统状态 + 桶列表 | indexer.js |
| dream | 对话开头自省消化 | dream.js（review 部分） |

## 存储方案
使用 Obsidian 兼容的 Markdown 文件（YAML frontmatter 存元数据）。
服务启动时扫描文件建立内存索引，运行时读写索引，同步写入 md 文件。
用户可通过 Obsidian 直接查看和编辑记忆文件。
API 调用结果缓存到 SQLite（dehydration_cache.db），相同内容不重复请求。

## 目录结构

```
lori_maomao_memorydraft_v1/                (monorepo)
├── CLAUDE.md
├── memory-service/                         # 独立 Node.js 服务（核心）
│   ├── package.json
│   ├── config.js                           # 全局配置（双模型在这里）
│   ├── server.js                           # HTTP 入口（Express 5）
│   ├── BACKLOG.md                          # v1 已知接受风险清单
│   ├── src/
│   │   ├── routes.js                       # REST: /breath /hold /grow /trace /pulse /dream
│   │   ├── bucket_manager.js               # 桶 CRUD
│   │   ├── storage.js                      # md 文件 + YAML frontmatter（纯 I/O）
│   │   ├── indexer.js                      # 内存索引 + pulse
│   │   ├── decay.js                        # 衰减引擎（后台定时任务）
│   │   ├── retriever.js                    # breath（检索 + 权重池浮现）
│   │   ├── extractor.js                    # hold/grow（打标 + 合并）
│   │   ├── dream.js                        # review + trueDream（v2）
│   │   ├── dehydrator.js                   # 脱水/合并/打标（调 LLM）
│   │   ├── llm_client.js                   # 双模型客户端（realtime + review），纯 fetch
│   │   └── cache.js                        # 脱水结果缓存
│   ├── memories/                           # Obsidian vault
│   │   ├── dynamic/  archived/  feel/
│   │   └── notebook/
│   │       └── notebook.md                 # 置顶备忘（每次对话注入）
│   └── cache/
│       └── dehydration.db
└── clients/
    └── sillytavern-extension/              # 酒馆插件（第一个客户端）
        ├── manifest.json
        ├── index.js
        ├── src/
        │   ├── config.js                   # 客户端配置（服务端 URL / 端口 / 鉴权 token）
        │   └── api_client.js               # REST 客户端
        └── ui/
            └── settings.html
```

## 技术约束
- 服务语言：JavaScript（Node.js ≥ 20.0.0，ESM）
- 不依赖 Python 运行时
- LLM 调用使用纯 fetch（不依赖 openai SDK），支持任意 OpenAI 兼容 API
- 前期不引入向量检索，用关键词模糊匹配（fuse.js）
- 向量检索作为后续可选增强
- 默认衰减参数：λ=0.05，归档阈值=0.3，合并阈值=75
- 配置项不硬编码，统一走 config

## 编码规范
- 函数职责单一，文件不超过 200 行
- 错误处理：失败时 log + 降级，不中断对话流程
- 中文注释
- storage.js 单进程假设：同桶并发写由 bucket_manager 串行化，storage 层不加 per-file mutex

## 工作流

### Pre-commit Review
写完 → Lori code review（架构 + 逻辑）→ /codex:adversarial-review（安全 + 边界）→ 通过 → commit

### Review 收敛条件
- No critical → 必须修
- No new high from real misconfiguration scenarios → 必须修
- High from 主动作恶/攻击者场景 → backlog，v1 threat model 不覆盖
- Medium 及以下 → 记录 backlog，不 blocking
