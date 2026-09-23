# 开发版同步验收记录

## 来源与结果

- dev commit：`a00bf1144391d49661d96c1a26578ad91f2e6523`（上一基线 `b4e0591`，含 v0.5.7、v0.5.8 及其后 git-status 修复）。
- 合并方式：整合树分支 `local/b4e0591-zh`，先提交本地补丁（`2d9c86b`），再 `git merge origin/dev`。
- 本地验收：strict 类型检查通过；`bun test ./tests/` 71 项回归全部通过；pi 0.87.1 真实加载器冒烟和 inline 宿主探针通过。
- 完整上游 suite（vitest 5.0.1）：2223 通过，6 失败，共 2229。**未宣称全绿**；6 项失败均来自本地 token 策略，见下。

## 上游变更与处理

| 上游变更 | 处理 |
| --- | --- |
| `agent-context.ts`：用宿主 `createInitialSystemMessage` + `toToolDeclaration` 构造 system 载体，兼容 ≤0.86 | 采用，替代本地手写 system 消息 |
| `turn-cap.ts`：同时输出 `shouldStopAfterTurn` / `finishTurn` | 采用，删除本地 `turn-limit.ts`，本地测试改用 `createTurnCap` |
| provider stream 处理函数绑定 config 作为 `this` | 采用 |
| `compact-failed`：`pi.on.bind(pi)` | 采用 |
| git 子进程清理 `GIT_DIR` 等仓库定位环境变量 | 采用 |
| `cosmetic-output`：`isObject` 守卫 | 采用，替代本地 `unknown` 写法 |
| `observationPoolTokens()` 统一观察池度量；memory 命令在 manual 模式计入 pending | 采用结构，但改为按 content 重算 token（本地策略） |
| `package.json` 入口改为 `dist/index.js`、pnpm 11.27.1、dependabot、CONTRIBUTING | 不采用入口与工具链；文档随合并保留在整合树 |

## 剩余上游断言差异（本地策略）

`upstream-tests/pool-consistency.test.ts` 6 项：测试 fixture 的 `tokenCount`（700 等）与 content 长度不一致，上游直接求和 `tokenCount`；本地不信任已存 `tokenCount`，按 content 保守重算，因此绝对值不同。触发器、状态栏与 memory 命令仍共用同一个 helper，一致性不受影响。

- observationPoolTokens sums and counts the active observations
- observationPoolTokens excludes tombstoned observations from the sum and count
- observationPoolTokens adds every pending observation batch when pending is supplied
- observationPoolTokens matches the inline fold sum on a pre-compaction branch (no snapshot)
- trigger / display pool agreement auto mode
- trigger / display pool agreement manual mode

## 已完成的测试适配

仅整合副本调整：上游新测试从 `tests/` 移到 `upstream-tests/`；`fixtures/pi-extension-api.ts` 保留本地 turn_end 取消订阅实现；`observer.test.ts` 修正合并残留变量。

## 文件与风险边界

- 全量 JSON：`R:/Temp/blackhole-sync-a00bf11.json`；日志：`R:/Temp/blackhole-sync-a00bf11.log`。
- 未调用远程模型，未压缩真实会话，未重建历史记忆。需要完全重启 pi 验证交互运行。
