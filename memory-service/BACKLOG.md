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
