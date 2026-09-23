# 开发版同步验收记录

## 来源与结果

- dev commit: `b4e0591a11d8bae8ff8be771ed298558bfab455e`。
- 本地 `bun run check` 通过：71 项回归、strict 类型检查、pi 0.87 加载器、inline 宿主探针。
- 根据官方 0.87 更新日志额外修复三种 worker 的 finishTurn 轮数限制；真实离线 Agent 循环验证停止请求且不提交部分结果。
- 完整上游 suite：2142 通过，45 失败，共 2187；**未宣称全绿**。

## 剩余上游断言差异

保留失败结果，不通过放宽生产安全约束让它们变绿。主要类别：
- 本地策略差异：精确去重而非模糊删除、CJK 更保守估算、旧 tokenCount 重算、oldest-first 连续覆盖与全量分批。
- 测试替身仍需适配：lazy-workers 整模块 mock 缺少本地 prepareObserverInput；dropper 旧提示词字面量；部分 consolidation 预算假设。
- 环境与工具链差异：Windows 路径/只读权限断言、模型配置测试用斜杠正则求 dirname、上游 fixture 类型检查依赖 TS6 --ignoreConfig 及 tests/ 原路径（本地 TS5.9，独立 strict 检查通过）。
- 因完整上游 suite 未通过，本次验证不等同于所有上游行为兼容；真实模型与长会话仍需交互验证。

完整失败用例：

### blackhole-export.test.ts
- /blackhole-export exports tiers, dedup, reflections, dropper notes and orphans to markdown

### config-simplification.test.ts
- saveUnifiedConfig — atomic write does not crash on read-only filesystem (returns false)

### consolidation.test.ts
- anyStageDue with cursors dropper due when pool fullness passes a lowered fullness threshold
- capSourceEntriesToTokens custom_message with string content contributes tokens (not 0)
- capSourceEntriesToTokens custom_message with array content contributes tokens
- capSourceEntriesToTokens message entries are still capped correctly
- capSourceEntriesToTokens branch_summary entries are still capped correctly
- capSourceEntriesToTokens cap respects maxTokens across mixed entry types
- capSourceEntriesToTokens oversized newest entry is still included (first-entry guard)
- capSourceEntriesToTokens blackhole-pre-compaction-output custom entries contribute 0 tokens
- observer preamble cap caps priorObservations in auto mode via observerPreambleMaxTokens
- observer preamble cap defaults to 30% of observerChunkMaxTokens when observerPreambleMaxTokens is 0
- observer preamble cap caps priorReflections in auto mode via observerPreambleMaxTokens

### dedup-algorithms.test.ts
- dedup algorithms clusterObservations with drift guard clusters exact and fuzzy duplicates without drift

### dropper-coverage.test.ts
- V3 dropper reflection coverage helpers summarizes coverage counts and token totals by relevance
- V3 dropper reflection coverage helpers summarizes coverage transitions by relevance without exposing ids

### dropper.test.ts
- V3 dropper agent passes budget-return max drops as a hard upper bound

### lazy-workers.test.ts
- lazy worker imports loads only the due worker and reuses it on retry
- lazy worker imports loads all stages on demand without changing their ledger output

### memory-command.test.ts
- /blackhole-memory command status Obs pool uses the live active observation pool, not the compaction snapshot

### model-budget.test.ts
- config parsing — contextWindow on OmModelConfig parses contextWindow from model config
- config parsing — contextWindow on OmModelConfig parses contextWindow on fallback models
- config parsing — contextWindow on OmModelConfig rejects non-positive contextWindow values during parse
- config parsing — contextWindow on OmModelConfig rejects NaN contextWindow values during parse

### om-ledger-robust.test.ts
- om-ledger-robust buildCompactionProjection marks fullFold when observation tokens exceed max
- om-ledger-robust buildCompactionProjection returns all reflections regardless of fullFold
- om-ledger-robust buildCompactionProjection fullFold remains true even if budget is exactly reached

### om-tokens-cjk.test.ts
- estimateStringTokens — CJK script awareness (#106) counts pure CJK ideographs at ~1 token per char (was ~0.25)
- estimateStringTokens — CJK script awareness (#106) counts kana at ~1 token per char
- estimateStringTokens — CJK script awareness (#106) counts hangul at ~1 token per char
- estimateStringTokens — CJK script awareness (#106) blends mixed CJK + ASCII text
- estimateStringTokens — CJK script awareness (#106) counts supplementary Han (astral plane) at ~1 token per code point

### pi-extension-api.test.ts
- extension API double preserves callback argument types through capture and replay

### projection.test.ts
- buildCompactionProjection triggers full fold when observations pool exceeds threshold
- buildCompactionProjection — compact-all (firstKeptEntryId="") triggers full fold and caps observations when pool exceeds budget
- bounded compaction snapshots caps rendered output on normal/full-fold paths (stored tokens 0)
- bounded compaction snapshots compact-all retains eligible memory and drops, fullFoldAlways=false
- bounded compaction snapshots compact-all retains eligible memory and drops, fullFoldAlways=true

### reflection-dedup.test.ts
- reflection fuzzy clustering merges a one-word reflection paraphrase into one cluster
- export variant hiding renders a fuzzy observation pair as a single bullet
- export variant hiding records the hidden variant count instead of a sub-bullet
- coverage survives variant hiding keeps a single-session medium cluster cited only through a non-rep variant id

### config-manager.test.ts
- test-mode path safety respects explicit PI_CODING_AGENT_DIR even in vitest

### env-paths.test.ts
- pi-base paths and env paths should return extensions dir

### config-flow.test.ts
- ConfigFlow smoke tests save first project save notifies with absolute path

## 已完成的测试适配

仅整合副本调整：Windows Git 正斜杠 key；状态栏真实内容 token fixture；中文分句；observer mock 保留预算 planner；worker transcript system 消息和 finishTurn；压缩测试使用 pi 0.87 非 bundle CLI 路径及真实 parentId 链。原版仓库无源码补丁。

## 文件与风险边界

- 全量 JSON：`R:/Temp/blackhole-full-results.json`；日志：`R:/Temp/blackhole-full-final.log`。
- 本地 check：`R:/Temp/blackhole-check.log`。
- 部署哈希：本目录 `deployment-manifest.json`，备份目录同时留存。
- 未调用远程模型，未压缩真实会话，未重建历史记忆。需要完全重启 pi 验证交互运行。
- C 盘本地包仍是启用来源；R 盘不可用不影响扩展运行（上游验收工具除外）。
