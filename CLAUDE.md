# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述
SillyTavern 扩展插件，为角色对话提供持久记忆系统。
运行环境：SillyTavern 本地部署，Node.js。

## 参考项目
路径：D:\reference\Ombre-Brain\
这是一个基于 MCP + Python 的 Claude 记忆系统（Ombre Brain）。
参考其核心算法和机制设计，不采用其运行架构。

### 采用的设计
- Russell 情感坐标（valence 效价 + arousal 唤醒度，连续维度）
- 衰减公式：final_score = Importance × activation_count^0.3 × e^(-λ×days) × combined_weight × resolved_factor × urgency_boost
- 短期/长期权重分离：≤3天 time70%+emotion30%，>3天 emotion70%+time30%
- 新鲜度公式：freshness = 1.0 + 1.0 × e^(-t/36)，t为小时，下限×1.0
- 情感权重：emotion_weight = base + arousal × arousal_boost（默认 base=1.0, arousal_boost=0.8）
- 权重池修正因子：unresolved×1.0, resolved×0.05, resolved+digested×0.02, urgent(arousal>0.7+unresolved)×1.5, pinned=999(不衰减不合并), feel=50(固定不衰减)
- Dream 机制：对话开头自省消化旧记忆，能放下的 resolve，有沉淀的写 feel
- Feel 机制：模型自己的感受/沉淀，固定分数50，不衰减，不参与dreaming，不参与普通浮现，有 source_bucket 回链，用 domain="feel" 单独检索
- 记忆重构：检索时根据当前情绪状态微调 valence 展示值（±0.1）
- 双通道检索：关键词模糊匹配 + 向量语义相似度并联，去重 ```markdown
- 合并机制：相似度超过阈值（默认75）的记忆桶自动合并
- 对话启动序列：breath() → dream() → breath(domain="feel") → 开始对话
- 边界原则："记住发生了什么，不记你是谁"——身份层交给角色卡/system prompt，记忆系统只管事件流

### 不采用的部分
- MCP 协议及 server.py 服务层
- Python 运行时及所有 .py 脚本
- Docker / Cloudflare Tunnel / Render / Zeabur 部署方案
- Claude Desktop 集成方式

### 可参考但需适配的部分
- Obsidian 存储层设计（Markdown + YAML frontmatter），适配为插件本地文件读写
- API 脱水压缩 + SQLite 缓存（dehydration_cache.db），相同内容不重复调用 API
- 存量记忆批量补生成 embedding 的思路（后期可选）

## 功能映射（原项目 MCP 工具 → 本插件模块）

| 原项目工具 | 功能 | 本插件对应 |
|---|---|---|
| breath | 浮现/检索记忆 | retriever.js |
| hold | 存储单条记忆 + 自动打标 + 合并 | extractor.js + storage.js |
| grow | 日记归档，长内容拆分多桶 | extractor.js（批量模式） |
| trace | 修改元数据、标记resolved、删除 | storage.js |
| pulse | 系统状态 + 桶列表 | indexer.js |
| dream | 对话开头自省消化 | dream.js（新增） |

## 存储方案
使用 Obsidian 兼容的 Markdown 文件（YAML frontmatter 存元数据）。
插件启动时扫描文件建立内存索引，运行时读写索引，同步写入 md 文件。
用户可通过 Obsidian 直接查看和编辑记忆文件。
API 调用结果缓存到本地 JSON 或 SQLite，相同内容不重复请求。

## 技术约束
- 插件语言：JavaScript（SillyTavern 扩展插件规范）
- 不依赖 Python 运行时
- 记忆提取调用外部 LLM API（endpoint 可配置，支持任意 OpenAI 兼容 API）
- 前期不引入向量检索，用关键词模糊匹配（可用 fuse.js 替代 rapidfuzz）
- 向量检索作为后续可选增强
- 默认衰减参数：λ=0.05，归档阈值=0.3，合并阈值=75

## 目录结构（预期）
sillytavern-memory/
├── manifest.json          // 酒馆插件声明
├── index.js               // 主入口，注册hook
├── src/
│   ├── extractor.js       // 对话 → 记忆摘要（调LLM），含自动打标和合并逻辑
│   ├── storage.js         // 读写 Obsidian markdown 文件，CRUD + trace 操作
│   ├── indexer.js         // 内存索引构建与查询，pulse 功能
│   ├── retriever.js       // 根据当前对话拉相关记忆（breath），含记忆重构
│   ├── decay.js           // 衰减与权重计算，完整公式实现
│   ├── dream.js           // 对话开头自省消化机制
│   ├── feel.js            // feel 记忆的存取与管理
│   └── config.js          // 配置管理（API地址、衰减参数等）
├── ui/
│   └── settings.html      // 酒馆侧边栏设置面板
├── memories/              // 记忆文件存放（Obsidian vault 可指向此处）
│   ├── dynamic/           // 活跃记忆
│   ├── archived/          // 衰减归档的记忆
│   └── feel/              // feel 记忆（独立存放）
└── CLAUDE.md

## 编码规范
- 函数职责单一，文件不超过 200 行
- 配置项不硬编码，统一走 config
- 错误处理：失败时 log + 降级，不中断对话流程
- 中文注释