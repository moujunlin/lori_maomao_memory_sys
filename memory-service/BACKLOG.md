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

## 观察项

- feel 积累速度：v1 不限制 feel 产出频率，上线后观察实际每日 feel 条数。若月均超过 60 条（约日均 2 条），评估是否需要引入 feel 间自动合并或调高 λ_feel
- feel 与普通记忆检索竞争：feel 初始分范围 30-70，普通记忆衰减后可能长期低于此区间。观察是否出现 feel 霸占检索结果前列的情况
- recall 阶段写操作频率：观察实际触发 soft-resolve 和写 feel 的比例，确认并发风险评估是否成立
