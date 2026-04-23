# BACKLOG

v1 已知接受风险清单。条目规则：每项包含风险、为何 v1 接受、v2 或未来触发重评的条件。

## storage 写入

### copyFile 兜底非原子 + 可能覆盖 live 文件

- **来源**：Codex adversarial review round 2/3
- **现状**：`writeBucketFile` 在 Windows `rename` 失败（`EPERM/EBUSY/EEXIST/EACCES`）时走 `fs.copyFile(tmp, filePath)` 兜底，非原子写入。极端情况（进程崩、断电、磁盘满）下可能留下半截文件。当前仅 `console.warn` 提示走了兜底路径。
- **v1 接受原因**：单进程本地服务，rename 路径是主路径，兜底只在 Obsidian 占用文件等"读文件冲突"场景触发。加 per-file mutex 或二次 staging 的复杂度不值得。
- **重评触发**：
  - 改多进程/多 worker 架构
  - 发现生产环境有 bucket 文件 truncate/半截写入的 issue
  - 有用户报告 Obsidian 并发场景下的数据损坏

### 同桶并发写未在 storage 层加守卫

- **来源**：Codex adversarial review round 3
- **现状**：`writeBucketFile` 只通过注释声明"单进程假设 + 同桶并发由上层 `bucket_manager` 串行化"，storage 层不加 per-file mutex 或版本号。两个并发 caller 写同 `filePath` 时，最后 `rename` 的那个静默赢，没有 error/审计。
- **v1 接受原因**：v1 单进程，bucket_manager 保证串行是契约；storage 层不承担并发守卫职责。在代码里加 mutex 属于防御性过度设计。
- **重评触发**：
  - 发现 bucket_manager 有并发路径（比如异步 pipeline 里多个 coroutine 同时 flush 同一个桶）
  - 改多进程部署
  - 想把 storage 提升为可以独立使用的库

### notebook.md 单文件并发写无串行化

- **来源**：Codex adversarial review round 4
- **现状**：`storage.js` 新增 `readNotebookFile` / `writeNotebookFile`，底层用 `writeTextAtomic`（原子 rename，防 torn write）。但全项目只有一个 `memories/notebook/notebook.md`，startup review、realtime 听写员 pending 写入、daily reset 子项重置三条路径都会命中同一文件，且未建 `notebook_manager`。并发 read-modify-write 场景下，最后 rename 的那个静默赢，可能吞掉前一次的 pending 条目或 todo 状态变更（用户可见的数据丢失）。
- **v1 接受原因**：v1 单进程 + 三条写路径在时序上本身很少重叠（review 在对话启动、听写员在对话中、daily reset 凌晨 5 点）。在 notebook_manager 尚未实现时，storage 层只保证单次写不 torn；上层串行化是 notebook_manager 的契约职责，不在本次改动范围。
- **重评触发**：
  - 实现 notebook_manager 时必须同时落 per-file serialization（Promise 队列或 mutex）
  - 发现用户实际遇到过 pending 条目丢失 / todo 状态回滚
  - 改多进程/多 worker 部署
- **v2 修法**：新建 `notebook_manager.js`，对 notebook.md 的所有 read-modify-write 走单一 Promise 链串行；或在 frontmatter 加 `version` 字段做 CAS，版本冲突时拒绝写并让上层重试。

## config 路径边界

### symlink/junction 能绕过 assertInsideDir 的 startsWith 校验

- **来源**：Codex adversarial review round 3 补审
- **现状**：`assertInsideDir` 用 `path.resolve` + `startsWith` 做字符串 prefix 比较。如果 `paths.memoriesDir` 或 `paths.cacheDir` 被配成"名字在 rootDir 内但实际是指向外部目录的 junction/symlink"，校验会通过，但文件系统操作会落到 rootDir 外。
- **v1 接受原因**：v1 本地单进程部署，threat model 只覆盖"意外错误配置"，不覆盖"配置者主动创建 junction 来绕校验"（主动作恶场景）。
- **重评触发**：
  - 服务开始接受远程/多租户配置
  - 配置源变成不信任来源（如从网络获取）
  - 发现用户非故意地创建了 symlink 导致 confusion
- **v2 修法**：用 `fs.realpath` 解真实路径再 assertInsideDir，对不存在的路径则拒绝配置 symlink 父目录。

## LLM 客户端

### baseUrl 尾部 /v1 需用户自己写对

- **来源**：llm_client.js v1 设计讨论
- **现状**：`callLlm` 把 `baseUrl` + `/chat/completions` 直接拼，只剥末尾斜杠。不同厂商约定不一：OpenAI/DeepSeek 习惯 `https://api.xxx.com/v1`，部分网关是 `https://api.xxx.com`（自己加 /v1），少数是 `https://api.xxx.com/v1/`。写错就 404。
- **v1 接受原因**：v1 配置由用户手写，出错即 404 立刻暴露，不会静默。加规范化逻辑相当于替所有兼容端猜一次，反而容易搞错（比如已经含 /v1 的又被追加成 /v1/v1）。
- **重评触发**：
  - 支持配置 UI 后，用户不再手写 baseUrl，需要根据 provider 下拉自动补全
  - 发现同一 provider 的 SDK 在不同版本里对 /v1 的处理不一致，导致用户反复踩坑
- **v2 修法**：提供 `normalizeBaseUrl(baseUrl, provider?)`，按已知 provider 白名单规范；未知 provider 保持原样不动。

## config 结构

### feel 配置项暂无消费者（dead config）

- **来源**：Codex adversarial review（2026-04-22，commit 35be937 后 working tree）
- **现状**：`config.js` 新增 `decay.feelLambda`、`decay.feelBaseScore`、`decay.feelArousalMultiplier`，但 `decay.js` 尚未实现，没有代码消费这些字段。Codex 判定为 dead config，建议不 ship。
- **v1 接受原因**：集中配置架构下，config 先行、消费者后到是预期的时间差。当前按模块顺序推进（storage → config → indexer → bucket_manager → decay…），`decay.js` 实现后会自然消费这些字段。现在回滚 config 改动反而增加无意义的重复工作。
- **重评触发**：`decay.js` 实现后若仍有字段未被消费，则清理；或决定改用其他参数命名/公式时一并调整。

### config.json 被 .gitignore 隐藏运行时行为配置

- **来源**：Codex adversarial review（2026-04-22，commit 35be937 后 working tree）
- **现状**：`.gitignore` 忽略了 `config.json`，但该文件同时包含 secrets（API key）和运行时行为配置（阈值、路径、模型参数）。行为配置变更对 code review 不可见，reviewer 无法知道实际生效的值，可能导致部署与 review 预期不一致。
- **v1 接受原因**：v1 配置尚未完全稳定，等配置项冻结后统一拆分更合理。届时拆为：`config.json`（非敏感运行时配置，版本控制）+ `config.local.json` 或环境变量（secrets，gitignore）。当前先 backlog，不阻塞模块推进。
- **重评触发**：配置项稳定后（预计 indexer/bucket_manager/decay 完成后）统一拆分；或发现 `config.json` 中的运行时配置已导致实际部署和 review 预期不一致。

## storage 写入

### archive 先写后删非原子，可能短暂双存

- **来源**：bucket_manager.js archive 实现 review（2026-04-22）
- **现状**：`archive()` 先 `writeBucketFile(destAbs)` 再 `deleteBucketFile(srcAbs)`。若写成功但删失败（权限、磁盘满），同一个桶会同时存在于 dynamic 和 archived 两个目录。索引只指向 archived，但 dynamic 下的旧文件残留。
- **v1 接受原因**：单进程本地服务，delete 失败会抛 error 向上传播，不会静默成功。运维人员看到 error 后可手动清理。加事务或两阶段提交的复杂度不值得。
- **重评触发**：
  - 发现实际 archive 操作后出现重复桶文件
  - 改多进程/多 worker 部署
  - 需要支持自动回滚的批量归档
- **v2 修法**：引入两阶段标记（先写 archived + frontmatter 加 `archived: true`，后台异步删原文件）或文件系统硬链接 + 延迟删除；也可改为 `storage.moveBucketFile` 原子 rename（同盘）。

### merge 先写 target 再删 source，delete 失败会残留 source

- **来源**：Codex adversarial review（2026-04-22，commit 35be937 后 working tree）
- **现状**：`merge()` 先 `writeBucketFile(targetAbs)` 再 `deleteBucketFile(sourceAbs)`。若 target 写成功但 source 删失败，target 已被修改、source 仍在。调用方重试会重复合并内容，产生难以回退的状态。
- **v1 接受原因**：单进程本地服务，delete 失败抛 error 向上传播。idempotency 方案（merge marker / staging）对 v1 过重，实际触发概率极低。不自动重试，由调用方处理错误。
- **重评触发**：
  - 发现实际 merge 后出现重复内容
  - 需要支持自动回滚的批量合并
  - 改多进程/多 worker 部署
- **v2 修法**：引入 merge marker（如 frontmatter 加 `mergedFrom: [sourceId]`）或 staging 目录：先移 source 到 staging，写 target 成功后再删 staging。

### buildEntry 从文件名推导 id，忽略 frontmatter.id

- **来源**：Codex adversarial review（2026-04-22，commit ee97a52）
- **现状**：`buildEntry()` 从文件名提取 id（`extractId`），忽略 frontmatter 中的 `metadata.id`。用户通过 Obsidian 手动重命名文件（改 `_id` 后缀）后，rescan 会把同一内容当成全新桶，旧的引用（如 feel 的 source_bucket）断链。
- **v1 接受原因**：v1 不鼓励通过重命名修改 bucket 文件名。frontmatter.id 和文件名 id 不一致时的处理策略（warn 还是 error？用哪个为准？）需要清醒时仔细设计。当前行为至少不会静默丢数据，只是会多出一个 orphan 桶。
- **重评触发**：
  - 发现用户实际通过 Obsidian 重命名导致 feel source_bucket 断链
  - 需要支持 bucket 重命名/迁移的正式流程
- **v2 修法**：`buildEntry` 优先信任 `metadata.id`，文件名推导的 id 仅作一致性校验（不一致时 warn）；addEntry/rescan 时以 frontmatter.id 为权威来源。

## 观察项

- feel 积累速度：v1 不限制 feel 产出频率，上线后观察实际每日 feel 条数。若月均超过 60 条（约日均 2 条），评估是否需要引入 feel 间自动合并或调高 λ_feel
- feel 与普通记忆检索竞争：feel 初始分范围 30-70，普通记忆衰减后可能长期低于此区间。观察是否出现 feel 霸占检索结果前列的情况
- recall 阶段写操作频率：观察实际触发 soft-resolve 和写 feel 的比例，确认并发风险评估是否成立

## cache 模块

### recentTurns 客户端化

- **来源**：Codex adversarial review（2026-04-23）+ Lori review
- **现状**：`cache.js` 原设计包含 `_recentTurns`（FIFO 滑动窗口，保留最近 N 轮对话原文），用于 dehydrator 输入源。但记忆服务是 REST API，应保持无状态；对话轮次是客户端会话状态，不应由服务端全局单例维护。
- **v1 接受原因**：已按 review 建议从服务端移除 `_recentTurns`，对话轮次滑动窗口改由酒馆插件端维护，调 dehydrator API 时作为请求参数传入。当前 `cache.js` 已瘦身为纯热桶缓存，recentTurns 功能移至客户端实现。
- **重评触发**：
  - 酒馆插件端实现 dehydrator 调用时，需确认请求参数里带了对话轮次
  - 发现其他客户端（微信/小手机）也有类似的轮次缓存需求，评估是否提炼为公共客户端库
- **状态**：medium，blocked by 插件开发

### hotBuckets 读路径接入

- **来源**：Codex adversarial review（2026-04-23）+ Lori review
- **现状**：`cache.js` 的 `_hotBuckets`（LRU 热桶缓存）已在 `bucket_manager.js` 的 mutating 操作后联动失效（`removeBucket`），但当前没有任何读取模块（`retriever.js`、`extractor.js` 等）调用 `cache.getBucket()` 或 `cache.putBucket()`。cache 模块处于"有失效无填充"的半接入状态。
- **v1 接受原因**：cache 读路径的接入需要等 `retriever.js` 落地后才能明确调用点（检索时命中则 `putBucket`、miss 则回源读盘并填充）。当前先做写侧失效，不阻塞模块推进。
- **重评触发**：
  - `retriever.js` 实现时，必须接入 `cache.getBucket()` / `cache.putBucket()`，明确填充策略（仅检索命中填充？还是预加载？）
  - 发现读盘性能瓶颈，评估是否需要在 indexer 层也接入 cache
- **状态**：low，blocked by retriever

### hotBuckets 外部编辑感知缺失

- **来源**：Codex adversarial review round 2（2026-04-23）
- **现状**：当前 cache 失效仅覆盖 `bucket_manager.js` 的写操作（`update/remove/merge/archive`），但项目支持 Obsidian 外部编辑（`bucket_manager.update` 会 force-read 磁盘防覆盖）。若用户通过 Obsidian 改了一个桶，cache 不会感知，仍返回旧内容，直到 LRU 踢掉或某次写操作触发失效。
- **v1 接受原因**：cache 读路径尚未接入，没有调用方会实际读到 stale 数据。外部编辑失效是读路径接入时必须同步解决的问题，当前不阻塞。
- **重评触发**：
  - `retriever.js` 接入 `cache.getBucket()` 时，必须同时增加 freshness 检查（mtime/TTL/版本号），或在 `indexer.refresh/rescan` 中联动清理 cache
- **状态**：medium，blocked by retriever

### cache.hotBucketCapacity 配置无校验

- **来源**：Codex adversarial review round 2（2026-04-23）
- **现状**：`cache.js` 直接从 config 读取 `hotBucketCapacity`，未做类型/范围校验。若用户手写 `config.json` 时写成字符串（如 `"foo"`），比较 `_hotBuckets.size >= limit` 恒为 false，LRU 淘汰失效，导致内存无界增长；写成 `0` 或负数也会行为异常。
- **v1 接受原因**：配置错误会立即暴露（内存增长），且当前 cache 无读路径调用方，实际风险可控。加校验是低成本改进，但按威胁模型 medium  backlog 不阻塞 commit。
- **重评触发**：
  - cache 读路径接入前，必须在 `config.validate()` 中补校验：限定为整数且 >= 1，非法时回退默认值并 warn
- **状态**：medium

### partner_notes 读取函数返回结构不一致

- **来源**：Lori review（2026-04-23）
- **现状**：`storage.listPartnerNotes(dirAbs)` 返回扁平化对象 `{ id, tag, created, updated, content }`，而 `storage.readPartnerNote(dirAbs, id)` 返回原始结构 `{ id, meta, content }`（meta 为完整 frontmatter）。调用方需要知道两种结构差异才能正确消费。功能上无影响，但增加心智负担。
- **v1 接受原因**：v1 调用方尚未接入，实际影响为零。统一返回结构属于接口 polish，不阻塞功能推进。
- **重评触发**：
  - routes / retriever 接入 partner_notes 读路径时，统一为扁平结构或统一为 `{ meta, content }` 结构
- **状态**：low

## partner_notes 模块

### partner_notes 注入路径未实现

- **来源**：partner_notes 功能设计（2026-04-23）
- **现状**：`storage.js` 已提供 `listPartnerNotes / readPartnerNote / writePartnerNote`，`config.js` 已配置 `partnerNotesDir`，但 `recall` 或 `routes` 层尚未实现"每次对话启动时与 notebook 一起注入"的组装逻辑。当前 partner_notes 只是存储层就绪，上下文注入未落地。
- **v1 接受原因**：recall / routes 模块尚未实现，存储层先行不阻塞。等 recall 落地时一并接入。
- **重评触发**：
  - recall / routes 实现时，必须读取 `partnerNotesDirAbs` 下所有条目，与 notebook 内容一起组装成对话上下文注入
- **状态**：low，blocked by recall / routes

### partner_notes 裸覆盖无冲突检测

- **来源**：Codex adversarial review round 4（2026-04-23）
- **现状**：`storage.writePartnerNote()` 是 blind overwrite：不重读磁盘、不检查版本/mtime、无串行化。用户同时在客户端和 Obsidian 编辑同一条 partner note 时，后保存者静默覆盖前者，数据不可恢复。
- **v1 接受原因**：当前 routes / partner_note_manager 尚未实现，`writePartnerNote` 没有调用方，风险是理论上的。真正的冲突检测需要乐观锁（`expectedUpdated`）或 per-id 串行化，应在 manager 层实现而非 storage 层。
- **重评触发**：
  - 实现 `partner_note_manager.js` 或 routes 层写入接口时，必须加入 force-read 或 `expectedUpdated` 乐观锁，拒绝过时写入
- **状态**：medium，blocked by routes / manager
