# 上游同步验收记录

上一次（a621e01 / 0.5.9）的记录见 git 历史：`git log -p -- UPSTREAM-MERGE-REPORT.md`。

## 来源与结果

- 上游：tag `v0.5.10`（`be64de823f27d8be4195dbe0734409017b05240f`；上一基线 `a621e01`）。只合并发版 tag，`v0.5.10` 之后 dev 上未发版的提交（正则回溯、状态栏等修复）不合并。
- 合并方式：fork `main`（上一提交 `7d52ba8`）执行 `git merge --no-ff v0.5.10`。6 个文件冲突：`README.md`、`package.json`、`pnpm-lock.yaml` 取本地；observer、reflector、dropper 三个 agent 逐处手工合并（D4）。上游新增的 `tests/dropper-stream-error.test.ts`、`tests/reflector-stream-error.test.ts` 移到 `upstream-tests/`。
- 本地验收：`tsc --noEmit` 通过；`bun test ./tests/` 73 项全部通过；Pi 1.0.0 加载器与 inline 探针通过。
- 上游全量 suite（vitest 5.0.1）：2431 通过，25 失败，共 2456。25 项都已登记在 `docs/LOCAL-DIVERGENCE.md`（D2 20 项、D4 3 项、D5 1 项、D12 环境 1 项），下文汇总。

## 上游变更与处理

| 上游变更 | 处理 |
| --- | --- |
| #137 worker 出错处理：`WorkerStreamError`（带丢弃条数）、固定报错文字、`closedByCompleteBatch`、reflector `errorAfterClose`、`turnCap.exhausted` | 采用。D4 只保留两条：`length`/`toolUse`/`aborted` 也算未完成；轮数用尽且没有有效收尾时一律抛错（上游「一条没记就当空结果并推进」会跳过整段内容） |
| provider 错误与轮数上限同时出现时报告 provider 错误 | 采用（本地用 `providerFailed` 判断，否则 D4 的轮数检查会抢先） |
| reflector 返回值改为 `{ reflections, errorAfterClose }` | 采用；本地 D5 分批分支同步改为合并各批结果、保留第一条 `errorAfterClose`；`scripts/verify-live-workers.ts` 和 `tests/om-batch-safety.test.ts` 跟着改 |
| `/blackhole` 首次使用前预加载配置（manual 模式首次会被忽略） | 采用 |
| 判断能否压缩时带上当前模型设置（`compaction.modelOverrides`） | 采用 |
| 分支内容不足时提示「还没有可压缩的内容」，取消时少一条重复提示 | 采用 |
| 可重试状态码（429、5xx）只匹配完整数字 | 采用 |
| devDependencies 升级（pi 0.87.1、typebox 1.3.34、oxlint 等） | 不跟进；本地链接全局 pi，见 D12 |

## 剩余上游断言差异（本地策略）

- **D2（20 项）**：fixture 里 `tokenCount` 写得很大，content 却很短，本地按 content 算出的池很小，达不到压力阈值。
  - `pool-consistency.test.ts` 12 项。
  - `consolidation.test.ts`「dropper pressure valve」6 项，「showWorkerNotifications」dropper 2 项。
- **D4（3 项）**：observer、reflector、dropper 各 1 项，断言「轮数用尽、一条没记时当空结果」。本地改为抛错、保留游标。
- **D5（1 项）**：`consolidation.test.ts`「skips an undersized primary model for an uncapped pressure prompt and uses fallback」。本地没有 consolidation 层的窗口预检，改为在 agent 内分批。
- **D12 环境（1 项）**：`pi-extension-api.test.ts`「preserves callback argument types」。`node_modules` 里是 Pi 1.0.0，上游测试替身按 0.87.1 写，缺 Pi 1.0 新增成员。

## 已完成的测试适配

- 本地 `tests/agent-turn-limit-087.test.ts`：轮数上限的断言从「Incomplete agent response (toolUse)」改为 `turnCapExhausted` 的 `WorkerStreamError`。行为不变：依旧抛错、不提交部分结果。

## 文件与风险边界

- 全量 JSON 曾放在 `R:/Temp/blackhole-upstream-0510.json`（内存盘，重启后会丢失）；结论以本文件为准。
- 没有调用远程模型，也没有压缩真实会话。交互运行要完全重启 pi 后再验证。
