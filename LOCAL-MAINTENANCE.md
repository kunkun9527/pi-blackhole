# 本地 Blackhole 维护手册

`pi-blackhole-local` 是上游 `k0valik/pi-blackhole` dev 分支加本地补丁的版本。本地补丁以中文支持为核心，并附带几项记忆完整性和 recall 预算增强。

**所有与上游的行为差异、实现位置、不变量和合并规则都在 [`docs/LOCAL-DIVERGENCE.md`](docs/LOCAL-DIVERGENCE.md)。** 同步上游、解决冲突、修改差异相关文件、判断上游测试失败之前，先读它。

## 开始任何维护前：确认 R 盘工作区

R 盘是内存盘，重启后清空。原版仓库、整合树、上游测试依赖和 `R:/Temp` 里的验证产物都可能不存在。持久的只有两处：

- 本地补丁历史：GitHub fork `https://github.com/kunkun9527/pi-blackhole` 的 `main` 分支（上游 dev + 本地补丁）。
- 已部署代码：安装目录及其 `deployment-manifest.json`。

第一步永远是运行重建脚本（幂等：缺什么补什么，已存在就快进，不覆盖未推送的本地提交）：

```bash
bash C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local/scripts/bootstrap-workspace.sh
```

完成标志：输出以 `workspace ready` 结束。脚本会：

1. `R:/pi-blackhole-upstream` 不存在就从 `k0valik/pi-blackhole` 克隆，存在就 fetch；`dev` 快进到 `origin/dev`；添加远端 `fork`。
2. 本地 `main` 指向并跟踪 `fork/main`（不是上游的 main），以 worktree 形式检出到 `R:/pi-blackhole-integration`；原版仓库本身停在 `dev`。
3. 整合树的 `node_modules` 建成指向安装目录 `node_modules` 的 junction；在原版仓库执行 `pnpm install --frozen-lockfile --ignore-scripts`（上游测试需要它的 vitest）。
4. `core.hooksPath` 指向空目录：上游的 prepare 脚本会装 pre-commit/pre-push 钩子（lint、typecheck、`SKIP_PRE_PUSH_ALLOWED`），会拦住本地提交和推送到 fork。
5. 打印上游 dev、本地 `main`、已部署提交和尚未合并的上游提交数；已部署提交不在 `main` 历史里时报错。

脚本报 `WARNING: ... not on the fork` 表示有未推送的提交，先 `git -C R:/pi-blackhole-integration push`。安装目录里的脚本是最近一次部署的版本；重建后整合树里的 `scripts/bootstrap-workspace.sh` 是最新版。

需要对比原版运行效果、但不打算维护时，可以只看第 1 步生成的原版仓库，其他步骤无副作用。

## 位置与基线

| 项目 | 值 |
|---|---|
| 当前版本 | `0.5.9-dev.a621e01.local.1` |
| 上游基线 | dev `a621e01f0fc65c28cedac643ff9325f6f9fa3673`（v0.5.9）（记录在 `package.json` 的 `blackholeUpstream.commit`） |
| 上游 | `https://github.com/k0valik/pi-blackhole`，工作区远端名 `origin` |
| fork（持久） | `https://github.com/kunkun9527/pi-blackhole`，远端名 `fork`；只用 `main` 一个分支，内容是上游 dev + 本地补丁。**不要点 GitHub 页面上的 Sync fork / Discard commits**，那会用上游 main 覆盖或丢弃本地补丁；同步上游只走下面的流程（合并 `origin/dev`） |
| 原版仓库（R 盘） | `R:/pi-blackhole-upstream`，`dev` 只快进，不放本地改动 |
| 整合树（R 盘） | `R:/pi-blackhole-integration`，原版仓库的 worktree，分支 `main` 跟踪 `fork/main` |
| 实际安装 | `C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local`（无 git，靠 `deployment-manifest.json` 追踪） |
| 已部署的整合提交 | 安装目录 `deployment-manifest.json` 的 `integrationCommit` |
| 用户配置 | `C:/Users/Su/.pi/agent/pi-blackhole/pi-blackhole-config.json`（不属于代码，升级时不改） |

安装目录不包含：`upstream-tests/`、`src/**/*.test.ts`、`.github/`、pnpm 与 lint 配置、`work_docs/`。这些只在整合树里。

fork 是公开仓库：文档里含本机路径（`C:/Users/Su/...`），不要提交密钥、用户配置或会话数据。

## 同步上游流程

前提：已运行重建脚本。每步以括号内条件为完成标志。

1. **更新原版仓库**：重建脚本已完成 fetch 与快进；单独执行时用 `cd R:/pi-blackhole-upstream && git fetch --all --tags --prune && git switch dev && git merge --ff-only origin/dev`（`git log -1 dev` 为上游最新提交）。
2. **查看上游改了什么**：`git log --oneline <旧基线>..origin/dev` 与 `git diff --stat <旧基线> origin/dev -- src index.ts`，对照 `docs/LOCAL-DIVERGENCE.md` 的「文件 → 差异索引」标出会碰到本地差异的文件（每个被改动的 `src` 文件都已归类为「无本地差异」或具体 D 编号）。
3. **合并**：`cd R:/pi-blackhole-integration && git fetch origin && git merge --no-ff --no-commit origin/dev`（出现冲突列表）。
4. **解决冲突**（无剩余冲突标记，`git diff --check` 干净）：
   - `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 取本地版本，再手工吸收上游有意义的依赖变化。
   - 源码冲突按 `docs/LOCAL-DIVERGENCE.md` 对应条目的「不变量」和「合并注意」处理：保留本地不变量，吸收上游与之正交的改动。上游修好了本地补丁针对的问题时，可以改用上游实现，并把该条目移到「已回归上游」。
   - 上游新增在 `tests/` 的文件移到 `upstream-tests/`（`git mv`）；本地 `tests/` 只放本地 bun 测试。
   - 上游新增的 `tokenCount` 求和、从新到旧的截断、部分结果提交，都属于 D2/D3/D4 的回归，必须按本地规则改写。
5. **验证**（全部通过或失败只落在已知清单）：
   - `node node_modules/typescript/bin/tsc --noEmit`
   - `bun test ./tests/`（不要用 `bun test tests`，会匹配到上游 vitest 文件）
   - `node scripts/smoke-host.mjs`、`bun scripts/probe-inline-host.ts`
   - 上游全量：`node R:/pi-blackhole-upstream/node_modules/vitest/vitest.mjs run -c vitest.upstream.config.mjs --reporter=json --outputFile=R:/Temp/blackhole-upstream-<commit>.json`（配置按同级目录 `../pi-blackhole-upstream` 找 vitest，两个 R 盘目录名不要改）。失败必须能在 `UPSTREAM-MERGE-REPORT.md` 的已知清单或 `docs/LOCAL-DIVERGENCE.md` 的「上游预期失败」里找到；新增失败要么修代码，要么（仅限本地策略导致的）登记原因。`R:/Temp` 里的结果重启即失，需要留存的结论写进 `UPSTREAM-MERGE-REPORT.md`。
6. **更新记录**（三处一致）：`package.json` 的 `version` 与 `blackholeUpstream.commit`；`UPSTREAM-MERGE-REPORT.md` 写本次上游变更处理表和测试结果；`docs/LOCAL-DIVERGENCE.md` 同步增删差异条目、行数统计和基线 commit。
7. **提交并推送到 fork**：`git add -A && git commit && git push`（`git status -sb` 首行为 `## main...fork/main`，没有 `ahead`）。未推送的提交只在 R 盘，重启就会丢失，所以每次提交后立即推送。`node_modules` 被 .gitignore 忽略，`.codeindex/` 由重建脚本写入共享的 `info/exclude`。
8. **部署**：在整合树里运行 `python scripts/deploy-local.py --base <manifest 中的 integrationCommit>` 先看计划和漂移；`drift: none` 后加 `--apply`（打印 `backup:` 路径和 `deployed N files`）。脚本按自身所在仓库取文件，必须从整合树运行，不要从安装目录运行。它会先整包备份到 `C:/Users/Su/.pi/agent/backups/blackhole-deploy-<commit>-<时间>/`，确认 settings 和 Blackhole 配置未被改动，并更新 manifest。
9. **安装目录复验**：在安装目录 `bun run check`（71+ 项通过、加载器与 inline 探针通过），然后完全重启 pi（`/reload` 可能保留旧的 inline registry）。

若第 8 步报漂移，说明有人直接改了安装目录：先把漂移内容整理进整合树并提交，再部署。

## 验收范围

- 本地 `tests/` 覆盖中文提取、预算、分批、RPC 摘要、pi 0.87 真实 agentLoop 与 inline 宿主；测试不调用远程模型。
- 未覆盖：付费模型端到端质量、真实长会话压缩效果、历史记忆重建。大改动后在真实会话里跑一次长任务并看 `/blackhole-memory`。
- 调试日志：配置 `debugLog: true` 后写入 `C:/Users/Su/.pi/agent/pi-blackhole/debug.ndjson`。

## 回退

1. 退出 pi。
2. 从部署时打印的备份目录（或 manifest 的 `backup` 字段）把代码、`package.json`、脚本恢复到安装目录；保留安装目录的 `node_modules` 联接，不整份还原 settings 和用户配置。
3. manifest 中 `new: true` 的文件是新版才有的，删除前另行确认。
4. 重启 pi，并在安装目录运行 `bun run check`。

历史备份：`backups/blackhole-a00bf11-merge-20260923-162508`（a00bf11 合并前，local.4）、`backups/blackhole-dev-merge-20260921-235824`（b4e0591 合并前）。
