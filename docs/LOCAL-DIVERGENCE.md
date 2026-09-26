# 本地版与上游的差异清单

本文件是本地版 `pi-blackhole-local` 与上游 `k0valik/pi-blackhole` 所有行为差异的单一事实来源。以下三种情况必须先读本文件：解决合并冲突、修改下表涉及的文件、判断某个上游测试失败是不是预期。

- 对照基线：上游 dev `a621e01`（v0.5.9）。对比命令：`git diff a621e01 main -- src index.ts ':!*.test.ts'`（整合树 `R:/pi-blackhole-integration`）。
- 差异规模：25 个源码文件，+835 / −830 行，新增文件仅 `src/om/input-budget.ts`。
- 上游全量 vitest 在该基线下 2328 / 2349 通过，21 项失败全部是下文登记的「上游预期失败」。
- 同步、验收、部署流程见根目录 `LOCAL-MAINTENANCE.md`。

## 总览

| ID | 差异 | 类别 | 影响范围 |
|---|---|---|---|
| D1 | Unicode 保守 token 估算 | 中文基础 | 所有预算、阈值、状态显示 |
| D2 | 不信任已存 `tokenCount`，按内容重算 | 中文衍生，全语言生效 | 观察池、折叠判断、dropper、显示 |
| D3 | observer 旧→新连续覆盖，排空积压 | 记忆完整性，全语言 | observer 阶段 |
| D4 | 完成判定严格化，不提交部分结果 | 记忆完整性，全语言 | 三个后台 worker |
| D5 | worker 输入预算与分批 | 记忆完整性，全语言 | 三个后台 worker 的提示词和请求 |
| D6 | 偏好、目标、阻塞项的中文提取 | 中文，含英文行为变化 | 压缩摘要各节 |
| D7 | 检索中文分词；导出只按原文精确去重 | 中文，全语言 | recall 排序、`/blackhole-export` |
| D8 | recall 字符与 token 双上限 | 本地增强 | recall 工具所有输出 |
| D9 | RPC 模式简短摘要与完整摘要恢复 | 本地增强 | RPC 模式压缩 |
| D10 | recall 折叠显示接入 | 本地集成 | recall 工具注册 |
| ~~D11~~ | 状态栏无 UI 时停用（0.5.9 起已回归上游） | — | — |
| D12 | 打包与工程 | 工程 | 入口、依赖、测试 |

---

## D1 Unicode 保守 token 估算

**目的**：上游 CJK 约 1 token/字；中文在部分模型上更贵，低估会让压缩和 worker 请求越界。

**实现**（`src/om/tokens.ts`）：
- `estimateStringTokens`：逐码点累加。ASCII 按 `1/ASCII_FALLBACK_CHARS_PER_TOKEN`（4 字/ token）；汉字、假名、谚文按 `CJK_FALLBACK_TOKENS_PER_CHAR = 1.5`；CJK 标点 1；BMP 外字符（emoji、生僻字）4；其余非 ASCII 按 UTF-8 字节数。取整 `ceil`。
- `estimateEntryTokens`：消息条目取 `max(纯文本估算, 宿主 estimateMessageTokens + (Unicode 估算 − chars/4 修正))`，保留宿主对图片、工具调用的开销；`custom_message`、`custom.data` 走 `estimateContentTokens`；`blackhole-pre-compaction-output`（仅 UI 展示）记 0，不产生观察压力。
- `messageText` 覆盖 `bashExecution`、`branchSummary`、`compactionSummary`、thinking、toolCall 参数。
- 有成功 assistant usage 时仍优先用真实 usage（`getUsageTokens`，与上游一致）。

**不变量**：这是保守启发式，不是 tokenizer；不得改回 `chars/4` 或上游 `cjkScriptStats`。

**测试**：`tests/chinese-support.test.ts`、`tests/audit-regressions.test.ts`（中文工具参数和 thinking 不按 ASCII 计）、`tests/integration.test.ts`（host summary、bash 包装）。

**上游预期失败**：`om-tokens-cjk.test.ts` 断言约 1 token/字（本地为 1.5）——整合树已对应调整；如上游改写该测试会再次冲突。

**合并注意**：上游改 `tokens.ts` 时保留本地估算函数，接受上游新增的 usage 相关逻辑。

## D2 不信任已存 tokenCount

**目的**：旧会话里的 `tokenCount` 是上游旧估算写入的，中文被低估约 3 倍；直接求和会让观察池看起来比实际小，折叠和 dropper 触发偏晚。

**实现**：凡是对观察/反思求 token 的地方都改为 `estimateStringTokens(content)`：
- `src/om/ledger/progress.ts` `observationPoolTokens()`：上游 0.5.8 新增的统一池计量函数，本地改为按 content 重算（含 manual 模式 pending 批次）。dropper 触发、状态栏 P 值、`/blackhole-memory` 都走它。
- `src/om/ledger/projection.ts` `buildCompactionProjection`：`fullFold` 判断。
- `src/om/agents/dropper/coverage.ts`：覆盖统计。
- `src/om/agents/dropper/agent.ts`：候选 token、已丢弃 token。
- `src/commands/memory.ts` `tokenSum`；`src/om/consolidation.ts` reflector/dropper 候选体积。

**不变量**：不改写旧记录里的 `tokenCount`，只在读取时重算。

**测试**：`tests/om-batch-safety.test.ts`（legacy tokenCount 不驱动池压力和覆盖统计）。

0.5.9 起 `livePoolObservations()`（ID 去重、pending drop 墓碑）由上游提供，本地只替换其上的 token 求和；dropper 压力基准改为 `observationsPoolMaxTokens`（上游修复）也已采用。

**上游预期失败**（fixture 写了很大的 `tokenCount`，content 却只有十几个字符，本地按 content 算出的池很小，达不到压力阈值）：
- `upstream-tests/pool-consistency.test.ts` 12 项。三个调用方仍共用同一 helper，一致性不受影响。
- `upstream-tests/consolidation.test.ts`「dropper pressure valve」6 项（fullness floor、全池压力、空结果不重试、池变化重新触发、manual 压力）和「showWorkerNotifications」dropper 2 项。把 progress.ts 与 dropper/agent.ts 临时改回 `tokenCount` 时这 8 项全部通过（2026-09-26 验证），说明压力逻辑本身已与上游一致。

**合并注意**：上游新增任何 `reduce(... o.tokenCount ...)` 都要改成按 content 重算；搜索 `tokenCount` 复查。

## D3 observer 连续覆盖（排空积压）

**目的**：上游 `capSourceEntriesToTokens` 从最新条目往回取 `observerChunkMaxTokens`，超出的旧条目不送给模型，但 `coversUpToId` 仍指向末尾，**旧内容永久漏记**。

**实测（2026-09-23，全部 460 个会话）**：444 次 observer 运行中 76 次（约 17%）积压超过 50k，集中在 10 个长会话；每次超出部分中位数约 56k token，最大一次积压约 210 万 token。

**实现**：
- `src/om/consolidation.ts` `capSourceEntriesToTokens`：改为从旧到新取连续前缀（单条超限仍至少取一条，由后续提示词检查处理）。
- `runObserverStage(pi, runtime, ctx, generation, resolveModel, runAgent?, drain=false)`：本批完成后若 `coversUpToId` 不是最后一个源条目，递归以 `drain=true` 继续处理（跳过 `observeAfterTokens` 阈值），直到积压清空。
- `src/om/agents/observer/agent.ts` `prepareObserverInput()`：用与真实请求相同的提示词布局（系统提示、工具 schema、消息包装、先前记忆），二分查找能放进 `initialInputLimit(limit)` 的最长前缀；`coversUpToId` 取实际送出的最后一条。先前记忆各占上限 10%，第一条源都放不下时先丢先前记忆；仍放不下抛 `InputBudgetError`。
- `InputBudgetError` 在 consolidation 里记为阶段错误并 `abort`，不推进覆盖，**不切换备用模型**（上游在窗口不够时会跳到下一个候选模型；本地的 limit 已按每个模型窗口计算，只有单条源超限才会报错，换模型通常无益）。

**不变量**：覆盖游标只能推进到真正送达模型的最后一条源条目；不跳过、不重排、不截断源条目。

**测试**：`tests/om-input-budget.test.ts`（observer 不越过未见条目、planner 计入包装和余量）。

**上游预期失败**：`consolidation.test.ts` 中 `capSourceEntriesToTokens` 与 observer preamble cap 相关用例（整合树已适配；上游若改写会重新冲突）。

**合并注意**：这是冲突最多的区域。上游改 observer 选取、preamble、context 预检时，保留本地连续前缀和 `prepareObserverInput`，只吸收与之正交的改动（日志、状态显示等）。

## D4 完成判定严格化

**目的**：上游只在「报错且一条结果都没有」时才抛错；只要记下了部分结果就当成功并推进覆盖，未处理的部分永久漏记。

**实现**（`src/om/input-budget.ts` `agentCompletionError`，三个 agent 共用）：最后一条带 `stopReason` 的消息为 `error`、`aborted`、`length`、`toolUse`（轮数用尽仍想调工具）或 signal 已中止时，整个运行抛错，不返回部分结果；`budgetedStream` 记录的预算错误同样抛出。

**例外（0.5.9 早停）**：`record_observations` / `record_reflections` 带 `complete=true` 且本批无拒收时返回 `terminate`，pi 在该工具结果后直接结束循环，最后一条 assistant 消息的 `stopReason` 仍是 `toolUse`。agent 把「最近一批是否 terminate」传给 `agentCompletionError(msgs, signal, completedByTool)`，只有这种情况放行；`error`、`aborted`、`length` 照常抛错。

**代价**：一批需要超过 `agentMaxTurns`（默认 16）轮才能处理完时会整批失败，下次触发重试同一批，产生重复调用。遇到这种日志时先调大 `agentMaxTurns` 或调小 `observerChunkMaxTokens`。

**测试**：`tests/agent-turn-limit-087.test.ts`、`tests/om-batch-safety.test.ts`（中止、输出截断、未完成工具响应不算完成）、`tests/om-input-budget.test.ts`（部分记录后失败不得报告成功）。

## D5 worker 输入预算与分批

**实现**（`src/om/input-budget.ts`）：
- `agentInputLimit(model, {inputMaxTokens, contextWindow}, fallback)` = `min(inputMaxTokens, 窗口 − boundedMaxTokens(model) − 1024)`；各阶段传入 `observerChunkMaxTokens` / `reflectorInputMaxTokens` / `dropperInputMaxTokens`。
- `initialInputLimit` = limit × 0.8，为工具调用和后续轮次留余量。
- `agentInputTokens` 按最终请求计：系统提示 + 工具 schema JSON + 128 + 每条消息 16 + 条目估算。
- `budgetedStream` 包装 stream：**每一轮请求**发出前复查（pi 0.87 下系统提示和工具声明在首条 system 消息的 `toolsAdded`/`sections` 里，由宿主估算计入），超限抛 `InputBudgetError`。
- `boundedContext` 裁剪先前记忆，保留整行并加省略标记；源记录本身永不裁剪。
- `planInputBatches` 在首次模型调用前规划全部批次；任何单项放不下立即抛错。

**各 worker**：
- reflector（`reflector/agent.ts`）：多批时逐批递归调用；同 id 反思合并 `supportingObservationIds`；任何一批失败，整次结果作废。
- dropper（`dropper/agent.ts`）：多批时传 `batchPressure {tokens, maxDrops}`，子批沿用整池压力，不按子批重算；汇总后用 `selectDropCandidates` 再施加一次全局上限。
- 先前记忆上下文上限为 limit 的 10%（上游 reflector 为 15%×2、dropper 20%）。
- consolidation 里删除了上游基于 `AGENT_LOOP_RESERVE = 8000` 的窗口预检和「跳到下一个候选模型」逻辑，改由 agent 内部精确规划。0.5.9 的 dropper 压力运行会把整个活动池作为候选，本地由 `planInputBatches` 分批，不需要换更大窗口的模型。
- 0.5.9 的 `runWorkerAttempt`（`workerAttemptTimeoutMs` 硬超时）和 `cacheRetention` 已接入三个阶段；本地 `InputBudgetError` 分支放在上游的 generation 检查之后。

**提示词措辞与上游不同**（维护时注意，影响输出质量对比）：
- observer 用户提示由 `observerText()` 生成、工具描述为 `OBSERVER_TOOL_DESCRIPTION`（供 `prepareObserverInput` 按真实布局计量）；0.5.9 起两者文字与上游逐字相同，含 `complete` 说明。
- reflector 末尾的 `complete` 指令与上游逐字相同；但把「NEW REFLECTIONS TO PROCESS」并入「EXISTING REFLECTIONS (context only)」，只把新观察作为处理对象（便于只对观察分批）。这是与上游的语义差异：新反思不再被要求二次提炼。
- dropper 标题改为「CURRENT REFLECTIONS (context only)」「EXISTING ACTIVE OBSERVATIONS (context only, not drop candidates)」。
- 系统提示（`prompts.ts`）与上游一致。

**测试**：`tests/om-input-budget.test.ts`、`tests/om-batch-safety.test.ts`、`tests/agent-transcript-087.test.ts`（真实 0.87 agentLoop 下系统指令和工具声明送达 provider，预算计入 schema 和 sections）。

**上游预期失败**：`consolidation.test.ts`「skips an undersized primary model for an uncapped pressure prompt and uses fallback」（本地没有窗口预检，见上）。`dropper.test.ts` 旧提示词字面量、`lazy-workers.test.ts` 整模块 mock 缺 `prepareObserverInput` 已在整合树适配。

**测试适配**：`upstream-tests/consolidation.test.ts` 的 observer mock 用 `importOriginal` 保留 `prepareObserverInput`，首次加载有真实 I/O；「worker attempt hard timeout」用例在 `vi.useFakeTimers()` 之前先预热该模块，否则超时计时器在测试推进假时钟之后才建立。

**合并注意**：上游改三个 agent 文件时，保留本地的 `limit / render / planInputBatches / budgetedStream / agentCompletionError` 骨架；上游在 0.5.7/0.5.8 引入的 `buildAgentContext`、`createTurnCap` 已采用，不要再换回本地旧实现（见文末「已回归上游」）。

## D6 偏好、目标、阻塞项的中文提取

**`src/extract/preferences.ts`（整体重写，英文行为也有变化）**：
- 识别：`ENGLISH_PREFERENCE`、`CHINESE_PREFERENCE`（始终/不要/禁止/希望/改用…开头）、`CORRECTION`（英文 stop/revert/undo/that's wrong，中文 不要/不用/别再/回退/停止/以后/下次/必须/记住，仅限句首）。
- 排除：问句（`?`/`？`、是否/为什么/怎么…、吗/呢结尾；「can you always…」等指令式问句保留）、代码块内容、超过 200 字的行（上游是截断到 200）。
- 条件和引号：含 如果/假如/除非/if/unless 或引号的整行不拆分，条件与指令保持绑定。
- 分句：中文按 `，。；;！` 拆分；「A 并且 B」中 A 为语言指令时 B 作为继承子句保留，不因 B 单独不像偏好而丢弃。
- 语言槽：`preferenceSlot` 只把独立的语言指令（用中文回复 / reply in English）归入同一槽，新的替换旧的，同句其他要求不受影响。
- 去重改为原文精确比较（上游小写比较）；保留**最新** 10 条（上游保留最早 10 条，且每个用户块只取 1 条）。

**`src/extract/goals.ts`**：范围变更与任务动词加入中文（改成/换成/接下来/新任务、修复/实现/重构…）；中文目标最短 4 字（英文 6）；「修复已完成」「请不要改」、问句、条件句不算新目标；中文任务行不要求长度 > 15。

**`src/core/build-sections.ts`（未解决问题）**：含汉字的行按 `，；。`、但是/但/but 分句；问句跳过；每个分句提取主语，「X 已修复 / 不再报错」只清除同一主语的待办，不遮住别的分句仍在失败的问题；否定修复（未解决、不是…修复）仍算未解决。去重键改为原文（上游小写）。英文沿用上游规则。

**测试**：`tests/chinese-support.test.ts`、`tests/second-review.test.ts`、`tests/audit-regressions.test.ts`、`tests/integration.test.ts`。

**合并注意**：上游改这三个文件时逐条对照上面规则；上游新增的英文模式可以并入 `ENGLISH_PREFERENCE` / `CORRECTION`。

## D7 检索中文分词；导出只按原文精确去重

**`src/project-recall/dedup.ts`**：
- `tokenizeContent`：用 `Intl.Segmenter` 分词（不可用时退回 `[\p{L}\p{N}]+`），NFKC + 小写，保留代码符号（`C#`、`C++`、路径、`@`），CJK 词不受英文最短 3 字与停用词过滤，额外加入 CJK 双字组合以兼容不同切分。**仅用于检索排序**。
- `normalizeContent` 保留标点，不再截断到 600 字；注明不能当作身份判断。
- 删除上游 Levenshtein / Sørensen-Dice / SimHash 模糊聚类，`exactContentKey(content)` 原文即身份。

**`src/project-recall/format-export.ts`**：`suppressCoveredByReflections` 只在观察与反思原文完全相同时隐藏观察。

**影响**：只影响 `/blackhole-export` 导出和检索排序，不影响账本、压缩和记忆删除。

**测试**：`tests/chinese-support.test.ts`、`tests/integration.test.ts`（反思只压制相同事实、导出保留不同的中文关键观察）。

**上游预期失败**：`dedup-algorithms`、`reflection-dedup`、`blackhole-export` 中依赖模糊合并的用例（整合树已适配）。

## D8 recall 字符与 token 双上限

**实现**：
- 配置 `recallResponseMaxTokens`（默认 12000，环境变量 `PI_BLACKHOLE_RECALL_RESPONSE_MAX_TOKENS`）与上游 `recallResponseMaxChars` 独立；任一为 0 只关闭该项（`src/core/unified-config.ts`、`src/core/config-env.ts`）。
- `src/core/recall-budget.ts`：`capRecallBlocks` 先丢尾部附加块再丢尾部条目，续读提示计入预算；极小预算按码点二分取前缀，绝不超限；`capRecallText` 用于 drill-down 文本。
- `src/tools/recall.ts`：所有分支（`#N`、记忆 id、搜索、错误、空结果）最后统一经过 `capRecallText`；`:full` 也受限。
- `#N:path` 采用上游 0.5.9 的 `expandEntryFileDetailed` + `capDrillDownText`（按行边界截断、给出可直接续读的 `offset:limit`），本地给 `capDrillDownText` 增加 `maxTokens`：字符和估算 token 两个上限取更紧的一个；为避免超大文件反复估算，先按「每字符至少 0.25 token」预切片再二分。
- `src/core/format-recall.ts`：touched 输出传入 token 上限。

- `example-config.json` 列出 `recallResponseMaxTokens`（上游 0.5.9 的完整性测试要求示例列出全部默认键）。

**测试**：`tests/audit-regressions.test.ts`、`tests/integration.test.ts`（真实 recall 执行器各路径有界、Unicode 不越界）。

## D9 RPC 模式摘要

**目的**：RPC 客户端只需简短提示，完整摘要不应刷屏，但模型必须看到完整摘要。

**实现**：
- `src/hooks/before-compact.ts`：`ctx.mode === "rpc"` 时 `compaction.summary = UI_COMPACTION_SUMMARY`，完整摘要存 `details.blackholeFullSummary`；下次压缩用 `readStoredFullSummary(latestCompactionEntry)` 作为 previousSummary。
- `src/hooks/compaction-context.ts`：`context` hook 把 compactionSummary 消息替换回完整摘要。
- `src/details.ts`：类型字段。TUI 模式不变。

**测试**：`tests/rpc-compaction.test.ts`。

## D10 recall 折叠显示

`index.ts` 的 `withCollapsedDisplay(pi)` 用 Proxy 拦截 `registerTool`，若全局存在 `Symbol.for("@local/pi-collapsed-tools.display-service.v1")` 且 `version === 1`，用其 `decorate(tool)` 包装 recall 工具。服务由 `local-packages/pi-collapsed-tools` 提供；不存在时原样注册，无副作用。

## D11 状态栏兼容

已回归上游（0.5.9，本地 PR #128）：`src/om/status-bar.ts` 与上游一致，保留编号只为兼容旧引用。

## D12 打包与工程

- 入口 `index.ts`（上游 0.5.8 起为 `dist/index.js`）；本地不构建 dist。
- `package.json`：`private`，名称 `pi-blackhole-local`，版本 `<上游版本>-dev.<commit>.local.<n>`，`blackholeUpstream.commit` 记录基线；pi 依赖为 peerDependencies 0.87.0，通过 `scripts/link-host.mjs` 链接全局 pi。
- `scripts/`：`smoke-host.mjs`（真实加载器）、`probe-inline-host.ts`（inline 压缩宿主探测）、`deploy-local.py`（部署，只能从整合树运行）、`bootstrap-workspace.sh`（R 盘内存盘清空后重建工作区）。
- `tests/`：本地 bun 测试；上游 vitest 测试放在整合树 `upstream-tests/`，不部署。
- 安装目录文件为 CRLF；整合树 `core.autocrlf=true`。
- 其他估算替换：`before-compact.ts` 的 `keptTokensEst`（上游为字符数 ÷ 4）、`core/compaction-chain.ts` 的压缩后估算（上游为宿主 `estimateTokens`）都改用 `estimateEntryTokens`。

---

## 文件 → 差异索引（解决冲突用）

| 文件 | 差异 |
|---|---|
| `index.ts` | D10 |
| `src/commands/memory.ts` | D2 |
| `src/core/build-sections.ts` | D6 |
| `src/core/compaction-chain.ts` | D12 |
| `src/core/config-env.ts`、`src/core/unified-config.ts`、`example-config.json` | D8 |
| `src/core/format-recall.ts`、`src/core/recall-budget.ts`、`src/tools/recall.ts` | D8 |
| `src/details.ts`、`src/hooks/compaction-context.ts` | D9 |
| `src/hooks/before-compact.ts` | D9、D12 |
| `src/extract/goals.ts`、`src/extract/preferences.ts` | D6 |
| `src/om/tokens.ts` | D1 |
| `src/om/input-budget.ts`（本地新增） | D3、D4、D5 |
| `src/om/consolidation.ts` | D2、D3、D5 |
| `src/om/agents/observer/agent.ts` | D3、D4、D5 |
| `src/om/agents/reflector/agent.ts` | D4、D5 |
| `src/om/agents/dropper/agent.ts` | D2、D4、D5 |
| `src/om/agents/dropper/coverage.ts`、`src/om/ledger/projection.ts`、`src/om/ledger/progress.ts` | D2（progress 另含 D5 的 `boundedContext`） |
| `src/project-recall/dedup.ts`、`src/project-recall/format-export.ts` | D7 |

不在表内的 `src/` 文件应与上游完全一致；出现差异即为未记录的漂移，先查明来源再合并。

## 已回归上游（不再是差异）

2026-09-23 同步 a00bf11 时改用上游实现，删除了本地版本：
- `src/om/agents/agent-context.ts`：替代本地手写 system 消息。
- `src/om/agents/turn-cap.ts`：替代本地 `src/om/turn-limit.ts`（已删除）。
- `src/hooks/cosmetic-output.ts` 的 `isObject` 守卫：替代本地 `unknown` 写法。

2026-09-26 同步 a621e01（v0.5.9）时采用：
- `#N:path` 按行截断与续读坐标（本地 PR #129 的上游最终版）。
- 状态栏：`src/om/status-bar.ts` 与上游完全一致（无 UI 守卫即本地 PR #128，上游已合并），D11 不再是差异；状态栏 P 值仍经 `observationPoolTokens()` 走 D2。
- worker 硬超时、`complete` 早停、`cacheRetention`、`showWorkerNotifications`、dropper 压力基准修复、`livePoolObservations`。
- 三个阶段的进度提示文字恢复为上游原文（数字仍是本地估算）。
