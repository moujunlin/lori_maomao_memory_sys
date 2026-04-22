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
