# 本地 Blackhole：开发版整合与 pi 0.87 适配

## 当前基线

- 版本：`0.5.6-dev.b4e0591.local.4`。
- 上游：`https://github.com/k0valik/pi-blackhole.git`，`dev`，`b4e0591a11d8bae8ff8be771ed298558bfab455e`。
- 原版仓库：`R:/pi-blackhole-upstream`（dev 分支，无本地源码补丁）。
- 整合工作树：`R:/pi-blackhole-integration`（以 dev 为基线，三方合并旧 v0.5.5 上的本地补丁）。
- 实际安装：`C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local`；settings 中仍只启用这个来源。
- 入口是 `index.ts`，不依赖旧 `dist/`。运行依赖链接全局 pi 0.87.0；版本约束见 package.json，升级宿主前重新验收。

## 本次合入

开发分支的文件修改归因（包括锚点编辑、bash）、Git 状态和提交识别、文件列表及摘要跨轮合并、CJK 分词检索、中文标点裁剪、observer 先前记忆上限、live status bar、压缩前输出保留、内存子会话 turn_end 压缩、createRequire 启动器宿主发现，以及 pi 0.87 compact helper 识别均已合入。

`src/om/inline-compaction.ts` 使用上游 dev 的完整实现，替代此前本地临时补丁。上游只检查 own prototype helper，因此隔离测试复制真实宿主的 prototype descriptors，而不再用空子类模拟同一宿主。

额外适配 pi 0.87：
- 按官方 0.87 发布说明，将三个 worker 已移除的 `shouldStopAfterTurn` 迁移到 `finishTurn`；达到轮数上限返回 `{ action: "end" }`，error/aborted 保持硬退出语义。真实离线 Agent 循环覆盖轮数限制及不提交部分结果。
- 官方参考：https://pi.dev/news/releases/0.87.0 。压缩继续通过宿主 compact 写入 SessionManager，不以单独覆盖 agent.state.messages 代替会话历史；`context` hook 只处理非 system 消息，系统提示与工具声明交由新版宿主恢复。
- observer / reflector / dropper 的 system prompt 改为 `context.messages` 中的 system 消息；旧 `context.systemPrompt` 在新版真实 agentLoop 中会丢失，不只是类型报错。
- `cosmetic-output.ts` 以 unknown 输入做运行时消息校验，避免新版消息联合类型与 Record 守卫交叉后误收窄为 never。
- 新 status bar、memory command 的活动池用内容重新估算，保持与本地预算一致；UI-only `blackhole-pre-compaction-output` 不计入观察源压力。

## 必须保留的本地行为

1. **无损身份判断**：删除或合并事实只允许完整原文相同；中文分词、规范化、相似度仅用于检索排序。`C#` / `C++`、大小写、路径分隔符、否定范围和长文本末尾不被模糊合并。
2. **中文约束**：保留否定及条件作用域；语言偏好只替换独立语言指令，不丢弃同句的其他要求；已解决状态只清理相同主题，不能遮住另一分句的失败。合入上游明确更正指令和完整窗口错误重试识别。
3. **recall 双预算**：字符与 token 上限独立，任一为 0 只关闭对应限制。分页、展开、drill-down、错误和页眉都计入；`:full` 不绕过限制，原文不删除。
4. **预算不是 tokenizer 保证**：成功 assistant usage 优先；其余使用本地保守 Unicode 启发式，基本 CJK 约 1.5 token/字，ASCII 约 4 字/token。旧记忆 tokenCount 不可信，按内容重算，不改写旧记录。
5. **连续源覆盖**：observer 从旧到新处理连续前缀并排空积压；完整提示词含 system、工具 schema、消息包装、输出余量。单条超限保留原文、报错且不推进游标。reflector/dropper 全候选分批，所有批次成功才提交；dropper 有全局上限。保留每轮请求预算复查。
6. **现有集成**：RPC 简短显示与 details 中完整摘要恢复、recall 折叠显示装饰保留。

本地配置和历史会话不由此次代码升级迁移或重写。新状态栏遵循上游 `statusBar: true` 默认值，可通过 Blackhole 设置关闭；新增配置说明见 docs/CONFIG.md。

## 验收

在实际安装目录运行 `bun run check`：strict 类型检查（含本地测试）、本地回归、pi 真实加载器、inline 宿主探针。测试不调用远程模型。`tests/agent-transcript-087.test.ts` 用真实 pi agentLoop 和离线 provider stream 验证三种 worker 的 system 指令和工具声明确实进入请求。

上游测试单独保留在 R 盘整合树 `upstream-tests/`，由 `vitest.upstream.config.mjs` 执行；不要用 `bun test tests`，它会把名字包含 tests 的上游 Vitest 测试也匹配进去。使用 `bun test ./tests/`。

上游 suite 有针对 Windows、0.87 消息格式、测试会话 parentId 链和本地策略的有限测试适配。原版 suite 仍可在原版仓库查看。完整结果及失败分类见 `UPSTREAM-MERGE-REPORT.md` 和 R 盘验证产物。不能将重点测试通过表述为整个上游 suite 全绿。

未执行：付费 provider 端到端质量评测、用户真实长会话压缩、历史观察重建。重新启动 pi 后再验证交互运行；仅 /reload 可能保留旧 inline registry。

## 备份与回退

升级前完整源码备份（不含 node_modules、dist）：
`C:/Users/Su/.pi/agent/backups/blackhole-dev-merge-20260921-235824/package`。

如需回退，先退出 pi，将该备份中的代码、package.json 和本地维护脚本恢复到实际安装目录；保留当前 node_modules 目录联接及用户配置，不整份还原 settings。用此次 `deployment-manifest.json` 中的新增文件清单识别仅新版存在的文件，删除前另行确认。恢复旧入口后新文件不会被加载；重启 pi。

后续同步以本次 dev commit 为三方合并基线，先在 R 盘整合树操作，通过本地中文/预算/Agent transcript 测试和宿主探针后再部署。不要用上游的整目录覆盖替代三方合并。
