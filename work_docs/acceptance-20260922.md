# Blackhole 最终验收 — 2026-09-22

## 结果：已修复、已部署、安装目录复验通过

保留 `midRunCompaction: resume`。用户配置和历史会话/记忆未改动。

### 根因与修复

1. Blackhole 旧版宿主发现和 compact-shape 检查不兼容 Pi 0.87。此前已整合 dev b4e0591 与本地安全补丁，支持 canonical context、turn_end inline compaction 和下一轮上下文刷新；三种 worker 使用 system transcript 与 finishTurn 轮数上限。
2. headless SDK 的状态栏访问未初始化 theme。以 ctx.hasUI 门控 UI 访问，先红测后修复，27 项状态栏回归通过。
3. 真实验收完成后退出挂起来自 CLIProxyAPI 的 WebSocket 缓存竞态，而非压缩未完成。主会话与记忆 worker 使用同一个 session/account key 并发冷连接，后一个连接覆盖前一个缓存项，遗留 socket 和 30 分钟定时器。适配层现保留首个缓存 owner，后到连接作为 transient，在 release 时关闭；源码形状不匹配则明确拒绝应用补丁。未修改 Blackhole 会话归因，也未禁用 WebSocket 或 resume。

### 红绿证据

- 原始完整离线 WebSocket 回放：功能断言成功但 20 秒不退出；SSE 对照正常退出。
- 仅改变并发缓存 key 即自然退出；生命周期跟踪确认两条连接只关闭一条。
- provider 回归先失败，修复后 3 项通过：并发冷连接不遗留 socket/timer、不同会话独立缓存、顺序请求复用。
- 已安装版本完整离线 WebSocket 回放：3 请求、1 次自动压缩、1 次续跑请求、1 次工具调用，保留工具结果，1.05 秒自然退出，独立服务仍运行。
- 已安装版本真实 CLIProxyAPI gemini-3.8-flash-high 验收：4 请求、1 次自动 turn_end inline compaction、压缩后 2 请求、1 次工具调用，项目名/端口/工具结果断言成功且进程自然退出，无强制 process.exit。日志：`R:/Temp/blackhole-live-installed-final.log`。
- 真实 Observer/Reflector/Dropper 管线此前已通过，各 2 次请求，共 6 次。精确端口、引用、合法删除 ID 和 critical 保护通过。
- 真实验收只使用 17 条合成历史和临时 PI_CODING_AGENT_DIR，不重建或压缩用户历史。

### 回归与构建

- 适配后的上游 suite：116 文件、2189 项全部通过。日志：`R:/Temp/blackhole-full-fixed.log`。
- 本地 suite：10 文件、71 项全部通过，安装目录再次通过。
- 严格 TypeScript 检查（包含 live/probe 脚本）、Pi 0.87 宿主加载、inline-supported 探针在安装目录通过。
- 本轮生产变更 status-bar/dropper 的 oxlint 与 oxfmt 检查通过。未宣称历史所有文件格式全绿。
- tsup ESM 构建通过：`R:/Temp/blackhole-build-final`。仅构建验收，不部署 bundle，当前扩展仍从 index.ts 加载。
- 构建时两次命令路径失败与 Windows 跨盘工作目录有关；通过 Python subprocess 显式 cwd 后构建成功。

### 部署范围与回退

- Blackhole：`C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local`，保留版本 `0.5.6-dev.b4e0591.local.4`。
- Provider：`C:/Users/Su/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/codex-stream.ts`。
- 本轮增量 18 文件，含生产补丁、验收脚本和 provider 回归；部署前备份，部署后逐文件 SHA256 校验，用户配置哈希未变。
- 备份：`C:/Users/Su/.pi/agent/backups/blackhole-final-20260922-013512`。其中 manifest.json 列出源、目标、前后哈希及备份位置；回退时先退出 Pi，恢复有 before 哈希的备份文件，删除 before=null 的本轮新增文件。
- 先前宿主链接恢复备份：`C:/Users/Su/.pi/agent/backups/blackhole-pnpm-links-20260922-010632`。
- 未部署 pnpm 自动安装意外改动的 pnpm-lock.yaml/pnpm-workspace.yaml，也未部署 package.json 或依赖。整合副本保留这些未审定文件，不能用于盲目重装。
- 避免在此环境使用 pnpm run：会自动安装并改写与活动扩展共享的 node_modules。验收直接调用工具。

### 维护提醒

- 完全退出并重启 Pi，当前进程可能仍缓存旧模块；不要仅 /reload。
- Provider 为本地补丁，后续 npm 更新可能覆盖。更新后重跑其 tests/websocket-cache-race.test.ts 和完整离线回放；上游源码形状变化需重新审核补丁。
- 离线回放复用了 live 脚本，其旧 PASS 文案中的 real model 不代表访问真实模型；本报告明确区分离线与 live 证据。
- 所有已定位阻塞均解决；这不意味着对任意未来 Pi/provider 版本作兼容保证。
