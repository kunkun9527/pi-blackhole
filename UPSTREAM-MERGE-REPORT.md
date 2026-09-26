# 开发版同步验收记录

上一次（a00bf11 / 0.5.8）的记录见 git 历史：`git log -p -- UPSTREAM-MERGE-REPORT.md`。

## 来源与结果

- dev commit：`a621e01f0fc65c28cedac643ff9325f6f9fa3673`（v0.5.9；上一基线 `a00bf11`）。
- 合并方式：fork `main`（上一提交 `28cd883`）执行 `git merge origin/dev`，10 个文件内容冲突，另有测试目录改名 / 删除冲突，逐个手工合并。
- 本地验收：`tsc --noEmit` 通过；`bun test ./tests/` 71 项全部通过。
- 上游全量 suite（vitest 5.0.1）：2328 通过，21 失败，共 2349。**没有全部通过**；21 项失败都是本地策略造成的，已登记在 `docs/LOCAL-DIVERGENCE.md`（D2 20 项，D5 1 项），下文也有汇总。

## 上游变更与处理

| 上游变更 | 处理 |
| --- | --- |
| dropper 压力基准由 `0.7 × reflectorInputMaxTokens` 改为 `observationsPoolMaxTokens` | 采用。本地配置（池上限 20000、reflector 输入 100000）下，之前的压力清理实际从未触发 |
| 压力运行以整个活动池为候选（`livePoolObservations`，ID 去重、pending drop 墓碑） | 采用；token 求和仍按 content 重算（D2），超大池由本地 `planInputBatches` 分批（D5） |
| worker 单次调用硬超时 `workerAttemptTimeoutMs`（`runWorkerAttempt`） | 采用，三个阶段都接入；默认关闭 |
| `record_observations` / `record_reflections` 的 `complete` 早停 | 采用。本地 `agentCompletionError` 增加 `completedByTool` 参数，只放行这种正常结束的 `toolUse`（D4），否则每次早停都会被当成失败，observer 整批失败 |
| `cacheRetention`（prompt cache 保留时长） | 采用，三个阶段透传；默认不设置 |
| `showWorkerNotifications`（可关闭常规进度提示） | 采用；三个阶段的提示文字恢复为上游原文 |
| recall `#N:path`：`expandEntryFileDetailed` + `capDrillDownText`（按行截断、给出续读坐标） | 采用，并给 `capDrillDownText` 加本地 token 上限（D8） |
| 状态栏无 UI 守卫（本地 PR #128） | 采用，`status-bar.ts` 与上游一致，D11 回归上游 |
| 删除未使用的 configure / status overlay 及其测试 | 采用 |
| `providerIdleTimeout` 持久化、泄漏 `GIT_DIR` 防护、`example-config.json` 完整性测试 | 采用；示例配置补上本地 `recallResponseMaxTokens` |
| observer 在部分结果后报错仍推进覆盖；从新到旧截断积压 | 上游仍未修；本地已有 D3 / D4，保留 |

## 剩余上游断言差异（本地策略）

- **D2（20 项）**：fixture 里 `tokenCount` 写得很大，content 却很短，本地按 content 算出的池很小，达不到压力阈值。
  - `pool-consistency.test.ts` 12 项。
  - `consolidation.test.ts`「dropper pressure valve」6 项，「showWorkerNotifications」dropper 2 项。把 `progress.ts` 和 `dropper/agent.ts` 临时改回 `tokenCount` 后这 8 项全部通过，说明失败只来自 token 计量，压力逻辑本身和上游一致。
- **D5（1 项）**：`consolidation.test.ts`「skips an undersized primary model for an uncapped pressure prompt and uses fallback」。本地没有 consolidation 层的窗口预检，改为在 agent 内分批。

## 已完成的测试适配

- 本地 `tests/om-input-budget.test.ts`、`scripts/smoke-om-manual.ts`：模拟的 `resolveModel` 补上 `source: "session"`，模拟的 runtime 补上 `tryEmitWorkerInfo`，以对齐 0.5.9 的类型。
- `upstream-tests/consolidation.test.ts`「worker attempt hard timeout」：先预热 observer 模块，再开启假计时器（原因见 D5「测试适配」）。

## 文件与风险边界

- 全量 JSON 曾放在 `R:/Temp/blackhole-upstream-059.json`（内存盘，重启后会丢失）；结论以本文件为准。
- 没有调用远程模型，也没有压缩真实会话。交互运行要完全重启 pi 后再验证。
