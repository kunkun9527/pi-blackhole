# pi-blackhole

**Deterministic compaction + session-aware observational memory for [Pi](https://github.com/earendil-works/pi) — in one unified extension.**

`/blackhole` replaces Pi's LLM-based `/compact` with an algorithmic structural summary — fast, zero-cost. Three background workers (Observer, Reflector, Dropper) capture durable facts and decisions that survive across compactions. Per-worker model fallback chains with persisted cooldowns. Manual flush mode. One JSON file to configure it all.

---

## Install

```bash
# From GitHub fork (with CJK & Long-Session Enhancements)
# Requires npmCommand to be set in settings.json, otherwise pi runs
# `npm install --omit=dev`, devDependencies are skipped, and dist/ is not built.
# Example: "npmCommand": ["npm"] in ~/.pi/agent/settings.json
pi install git:github.com/kunkun9527/pi-blackhole

# Or original upstream from npm
pi install npm:pi-blackhole
```

If you have standalone `pi-vcc` or `pi-observational-memory` installed, remove them first — they conflict and will prevent blackhole from loading:

```bash
pi uninstall npm / git:https://github.com/sting8k/pi-vcc
pi uninstall npm / git:https://github.com/elpapi42/pi-observational-memory
```

Then `/reload` or restart Pi. The config file at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json` is created with sensible defaults — no setup required for the default behavior. Config merges global → project → env → session (session is ephemeral). See **[`docs/CONFIG.md`](docs/CONFIG.md)** for tuning or run `/blackhole settings` to open the interactive overlay.

> **Want a guided setup?** Pass [`llms.txt`](llms.txt) to your agent — it will walk you through the interview, including picking cheap fallback models for your providers.

---

## 本 Fork 更新与增强 / Fork Enhancements

本仓库基于原版 [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole)（基线 v0.5.8+），针对 **中文对话交互**、**长会话记忆完整性** 以及 **上下文预算安全** 进行了深度优化与重构：

### 1. 中文深度兼容与增强 (CJK Support)
- **Token 准确估算**：针对 CJK 字符采用约 1.5 token/字更保守合理的估算规则（原版约 1 token/字严重偏低），消除中文长文本因低估 token 在压缩前挤爆硬上下文上限的隐患。
- **中文语义分词与检索**：`recall` 检索全面集成原生 `Intl.Segmenter` 分词与双字（bi-gram）索引，支持中文关键词搜索与上下文定位；长句按中文标点习惯合理断句截断。
- **偏好与指令精确提取**：优化中文条件句（「如果…」）与否定句（「不要…」）提取逻辑，复合语句拆分解析，避免多条中文偏好与要求被粗暴截断或漏判。
- **任务目标状态识别**：精准识别中文任务状态变迁（「已修复」、「仍然报错」等），独立追踪多个子问题，杜绝「解决一个问题误连带清除其他失败问题」的串扰。

### 2. 记忆完整性保障与排空机制 (Input Budget & FIFO Draining)
- **解决长任务旧记忆丢失问题**：原版 Observer 在积压消息超出单次窗口（如 50k tokens）时，会直接丢弃早期积压内容跳到末尾，导致长任务前中期的关键决策与代码排查记录永久丢失。
- **FIFO 自动排空与原子预算**：重构为从旧到新（FIFO）分批处理未观察积压（`drain=true`），多轮排空直到追齐最新进度；引入原子输入预算保护（`src/om/input-budget.ts`），模型超限或异常时原子回滚，不造成记忆空洞或虚假推进。

### 3. 精确去重 (Exact-only Deduplication)
- 移除原版模糊编辑距离（Levenshtein）聚类合并，仅对完全相同的原文进行去重。杜绝相似代码片段或语义接近的中文记录被算法误合并、误删。

### 4. 上下文预算双重拦截 (Recall Budget Protection)
- 引入字符与 token 双重响应上限（`DEFAULT_RECALL_RESPONSE_MAX_TOKENS = 12000`），保证检索展开（`#N:text` / `#N:path`）不会一次性塞爆当前上下文窗口。

### 5. Pi 0.87+ 深度适配
- 支持 Pi 0.87 的 `agentContext` 与 `finishTurn` 控制；支持中途压缩平滑继续（`midRunCompaction: "resume"`），避免长任务连续工具调用中途上下文溢出退出。

> 详细技术实现、受影响的文件清单与维护规则请参阅 [**`docs/LOCAL-DIVERGENCE.md`**](docs/LOCAL-DIVERGENCE.md) 和 [**`LOCAL-MAINTENANCE.md`**](LOCAL-MAINTENANCE.md)。

---

## What it does

Long engineering sessions degrade. Pi's native `/compact` calls an LLM to write a free-form prose summary — then compacts that summary, then compacts the next. After a few cycles, load-bearing details vanish: why a decision was made, which approaches were rejected, what the user clarified early on. The session is still alive; the agent has stopped carrying the real context.

`pi-blackhole` solves this in two complementary ways:

- **Algorithmic compaction** — a deterministic, zero-cost `compile()` pipeline extracts structured sections (goal, files, commits, preferences, brief transcript) and replaces the old conversation with one compact block. No LLM is called for compaction itself.
- **Observational memory** — three background workers (Observer → Reflector → Dropper) run during the session, capturing timestamped facts and distilling durable reflections in a session ledger that survives every compaction.

Both halves share a single hook and a single output. Together they keep the agent's context sharp across arbitrarily long sessions — without the cost, drift, or erosion of repeated LLM-based summarization.

---

## Commands

| Command                     | Description & Options                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/blackhole`                | Manual compact — deterministic structural summary                                                                                                       |
| `/blackhole settings`       | Open the configuration overlay _(Alias: `/blackhole configure`)_                                                                                        |
| `/blackhole changelog`      | Open the in-app changelog viewer                                                                                                                        |
| `/blackhole cleanup`        | Remove orphaned pending files                                                                                                                           |
| `/blackhole om-off`         | Disable observational memory                                                                                                                            |
| `/blackhole om-on`          | Enable observational memory                                                                                                                             |
| `/blackhole-memory`         | Memory pipeline status & token counters _(Same as `/blackhole-memory status`)_                                                                          |
| `/blackhole-memory view`    | Show visible observations and reflections (after compaction trimming), copied to clipboard                                                              |
| `/blackhole-memory full`    | Show **all** recorded memory (including dropped observations), copied to clipboard                                                                      |
| `/blackhole-recall <query>` | Search session history. Supports `page:N`, `scope:all`, `mode:file                                                                                      | touched`, regex *(Also available to agent as `recall` tool)* |
| `/blackhole-export`         | Export distilled project memory (observations/reflections across past sessions + pending buffers) to import-ready markdown _(Options: `out:<path>.md`)_ |

All commands work regardless of `compaction` mode — only _when_ auto-compaction fires changes. See [Compaction modes](#compaction-modes) below.

<details>
<summary>The `recall` tool (agent-facing)</summary>

The agent gets one unified `recall` tool that handles every form of historical lookup. Searches read the raw session file directly, bypassing compaction.

| Input           | What it does                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[12-char hex]` | Recover source evidence for a specific observation or reflection ID from the session ledger.                                                                                         |
| `#N`            | Expand a session entry by index (show full content, bounded by the response budget).                                                                                                 |
| `#N:path`       | Drill-down into file content from a tool call (e.g. `#42:auth.ts` shows first 30 lines; `#42:auth.ts:30` shows the next 30; `#42:auth.ts:full` shows everything).                    |
| `#N:text`       | Drill-down into a message body (user/assistant/tool/bash text) with the same paging (`#42:text`, `#42:text:30`, `#42:text:full`) — the continuation path for budget-clipped entries. |
| Free text       | BM25-ranked search across transcript and/or file content. Rare terms weighted higher.                                                                                                |
| `mode:file`     | Search only write/edit file content.                                                                                                                                                 |
| `mode:touched`  | Aggregate all files written/edited across the session, grouped by path.                                                                                                              |
| Regex           | Pattern search (e.g. `fork.*pi-vcc`, `hook\|inject`).                                                                                                                                |
| `scope:all`     | Search across all session lineages (default: active lineage only).                                                                                                                   |

When the agent expands a session entry (`#N`), related observations and reflections from the session ledger are automatically shown alongside the expanded content — so the agent gets the raw transcript _and_ the durable fact layer in one call.

Every recall response is capped at `recallResponseMaxChars` (default 48,000 ≈ 12k tokens). Search snippet lines, expanded entries, and related observation bodies are clipped to keep a single huge stored message from flooding the context; a truncation marker names the omitted entries and how to continue (`#N:text` / `#N:path` / `page:N`).

The `/blackhole-recall` command exposes the same engine to the user. Results are shown as a collapsible message and auto-fed to the agent as context.

</details>

---

## Compaction modes

Two modes, one shared goal: keep your agent's context sharp without manual housekeeping. (`compaction: "off"` is a third escape hatch that hands everything back to Pi.)

|                             | Auto (default)                                                         | Manual (`compaction: "manual"`)                  | Off (`compaction: "off"`)                                  |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Workers run?                | Yes                                                                    | Yes                                              | Yes (unless `memory: false`)                               |
| Observations go to          | Conversation markers (invisible in TUI)                                | Per-session disk buffers                         | Conversation markers                                       |
| Auto-compact on `agent_end` | Yes — fires at the auto-compaction threshold (preset curve by default) | No                                               | No (Pi handles it)                                         |
| `/compact` (Pi built-in)    | Replaced by blackhole                                                  | Pi handles                                       | Pi handles                                                 |
| `/blackhole`                | Optional                                                               | **Required** to flush + compact                  | Optional, but works                                        |
| Use case                    | "Install and forget"                                                   | "I want to control when context gets compressed" | "Let Pi handle it, but I want `/blackhole` when I need it" |

Manual mode is the maintainer's daily driver: workers still run, but observations accumulate in `<sessionId>-pending.json` files instead of cluttering the conversation. `/blackhole` flushes the buffer, runs algorithmic compaction, and injects durable reflections in one shot.

`compaction: "off"` + `memory: false` (or `PI_BLACKHOLE_PASSIVE=true`) completely disables all background workers and blackhole's auto-compaction — useful for debugging or comparing against Pi's native path. Explicit `/blackhole` still works in this mode.

#### Who owns the compaction?

With the default `compactionEngine: "blackhole"`, blackhole's `session_before_compact` hook owns every compaction Pi initiates — threshold auto-compact, overflow recovery, and `/compact` — replacing Pi's LLM summarizer with the deterministic pipeline. The only exception is defensive: if both the VCC summary and the OM projection come up empty (a pathological all-noise transcript), blackhole declines and Pi's native summarizer runs, so you never get a context-free replacement. With `compactionEngine: "pi-default"`, `compaction: "manual"`, or `compaction: "off"`, Pi handles everything except explicit `/blackhole`. See [`docs/CONFIG.md` → `compactionEngine`](docs/CONFIG.md#compactionengine) for the full interaction matrix.

### How does `/blackhole` compare to `/compact`?

- `/compact` calls an LLM to write a free-form summary — costly, lossy, no memory layer.
- `/blackhole` uses algorithmic section extraction (goals, files, commits, preferences…) **plus** injects observations and reflections from the session ledger. No LLM is involved in the compaction itself. Fast, deterministic, memory-preserving - the observational memory pipeline's arrived results apply instantly on compaction.

`/blackhole` is essentially a single `/compact` that just works — especially in manual mode.

---

## How it works

When `/blackhole` fires (manually or via the auto-trigger), two things happen in one shot:

1. **The vcc pipeline** analyzes the transcript tail and produces a structured summary: session goal, file changes, commits, outstanding blockers, user preferences, and a rolling brief transcript. Deterministic — same input always produces the same output.
2. **Observational memory injection** renders accumulated observations and reflections from the session ledger and appends them below the summary.

The agent receives a deterministic recap of recent work _plus_ durable facts from the full session history — in a single replacement block. No LLM was called for the compaction itself.

---

## Quick start config

Defaults target ~128k context models and work out of the box — no tuning required. To keep costs low, set cheap models for the background workers (the only required change for most setups):

```json
{
  "observerModel": { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free" },
  "reflectorModel": { "provider": "cerebras", "id": "gpt-oss-120b" },
  "dropperModel": { "provider": "cerebras", "id": "gpt-oss-120b" }
}
```

Fallbacks (optional): each worker tries `stageModel → stageFallbacks → base model → session model` (skipping cooled-down models). By default the workers **do not** fall back to your session model — this avoids surprise cost and cache busting. Enable it with `sessionFallback: true` (default) or set `model` as a shared fallback. See [`docs/CONFIG.md` → Model Configuration](docs/CONFIG.md#model-configuration).

Config file: **`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`**

Full reference — every key, default, and env override — lives in:

- 📘 **[`docs/CONFIG.md`](docs/CONFIG.md)** — authoritative config reference. Start here for tuning.
- 🤖 **[`llms.txt`](llms.txt)** — agent-facing interview. Pass it to your agent for a guided setup.
- 📦 **[`example-config.json`](example-config.json)** — annotated example with fallback rationale and `thinking` levels.

---

## Demo

`/blackhole` collapses ~143k tokens of conversation into a ~6.3k structured summary (YMMV based on your settings). `/blackhole-memory` shows pipeline status. `/blackhole-recall` searches history — the agent can do the same via its `recall` tool.

https://github.com/user-attachments/assets/a7dd804d-6aca-4bdb-8b6e-0dd779363a43

### The three memory workers

Three background workers (separate LLM calls) run automatically during the session when `memory: true` (the default):

- **Observer** — reads conversation since the last observation marker and extracts timestamped facts: events, decisions, preferences. Input is capped to `observerChunkMaxTokens` newest-first to prevent context blowup on long sessions. Runs most frequently.
- **Reflector** — distills new observations into durable reflections: stable facts, patterns, and constraints that survive future compactions. Runs less often.
- **Dropper** — prunes low-value observations from active memory when the pool exceeds `observationsPoolMaxTokens`, while keeping reflections and other long-term elements safely in the session ledger.

```
[Conversation turn] ──> (accumulated tokens >= observeAfterTokens)
                            │
                            v
                    1. OBSERVER   (extracts timestamped observations)
                            │
                            v
                    2. REFLECTOR  (synthesizes durable reflections)
                            │
                            v
                    3. DROPPER    (prunes low-value observations)
```

Each worker uses an `agentLoop` with tool-calling capabilities — they don't just make a single LLM call. The observer, for example, can call `record_observations` multiple times per run to work through a chunk incrementally.

If any stage fails (model error, rate limit, timeout), remaining stages are skipped and the full pipeline retries on the next `agent_start` or `turn_end`. A 30-second retry gate prevents hammering failing APIs. Within each stage, the runtime tries all configured fallback models before giving up — each failed model is cooled down and skipped in subsequent attempts.

---

<details>
<summary>What the agent sees after compaction</summary>

After compaction, the agent sees something like this (sections appear only when relevant — a session with no git commits won't show `[Commits]`):

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug...

[assistant]
Root cause is a missing token refresh...
...transcript continues...

---
The conversation before this point has been compacted into the summary above.
Details not captured here — exact code, error messages, file paths — are only recoverable via `recall`.
Use `recall` to search the session history. Do not redo work already completed.

## Reflections
[c3d4e5f6a1b2] User is building Acme Dashboard on Next.js 15 with Supabase auth.

## Observations
[a1b2c3d4e5f6] 2026-05-23 [high] User decided to switch from REST to GraphQL; motivation was reducing over-fetching.
[b2c3d4e5f6a1] 2026-05-23 [medium] GraphQL migration completed; user confirmed working.

----
Bracketed ids in reflections and observations connect to their source session entries.
These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use `recall` with an id to retrieve original context.
----
```

> **Note:** The OM injection format uses `## Reflections` and `## Observations` Markdown headers followed by a brief footer. Each observation and reflection has a 12-char hex identifier the agent (and you, via `/blackhole-recall`) can use to recover source evidence. When no observations or reflections exist, only the short recall-guidance footer is appended.

</details>

---

<details>
<summary>Feature comparison</summary>

|                                             | pi-blackhole | pi-vcc | pi-obs-memory | Pi default |
| ------------------------------------------- | ------------ | ------ | ------------- | ---------- |
| Algorithmic compaction (no LLM cost)        | ✓            | ✓      | —             | —          |
| Deterministic output                        | ✓            | ✓      | —             | —          |
| Structured summary sections                 | ✓            | ✓      | —             | —          |
| Observations + reflections                  | ✓            | —      | ✓             | —          |
| Context survives across compactions         | ✓            | —      | ✓             | —          |
| Background memory workers                   | ✓            | —      | ✓             | —          |
| Searchable history after compaction         | ✓            | ✓      | partial       | —          |
| Per-worker model config                     | ✓            | —      | —             | —          |
| Fallback model chains + persisted cooldowns | ✓            | —      | —             | —          |
| Manual flush mode (`compaction: "manual"`)  | ✓            | —      | —             | —          |
| Memory toggle (`/blackhole om-off`)         | ✓            | —      | —             | —          |
| Unified single-file config                  | ✓            | —      | —             | —          |
| Per-session pending state                   | ✓            | —      | —             | —          |

</details>

---

## Uninstall

```bash
pi uninstall git:github.com/k0valik/pi-blackhole
rm -rf ~/.pi/agent/pi-blackhole
```

---

## Documentation map

| Doc                                                          | Audience          | What's in it                                                                              |
| ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------- |
| **[`README.md`](README.md)**                                 | You, now          | Install, commands, the pitch, the value, the demo.                                        |
| **[`CHANGELOG.md`](CHANGELOG.md)**                           | You               | Every release, what changed, who contributed.                                             |
| **[`CONTRIBUTING.md`](CONTRIBUTING.md)**                     | You, if helping   | Branch model, dev setup, PR description format, docs/changelog gates.                     |
| **[`docs/CONFIG.md`](docs/CONFIG.md)**                       | You, when tuning  | Every config key with type, default, behavior, and env-var overrides.                     |
| **[`llms.txt`](llms.txt)**                                   | Your agent        | Step-by-step guided setup interview, anti-patterns, exact file paths, internal constants. |
| **[`docs/MIGRATION-GUIDE.md`](docs/MIGRATION-GUIDE.md)**     | You, if upgrading | Old → new config key mapping, semantic changes, automatic migration behavior.             |
| **[`docs/OLD_CONFIG.md`](docs/OLD_CONFIG.md)**               | Reference only    | The legacy pi-vcc / pi-observational-memory config surface. Kept for historical context.  |
| **[`example-config.json`](example-config.json)**             | You               | Annotated example config with comments.                                                   |
| **[`docs/APPEND_COMPACTION.md`](docs/APPEND_COMPACTION.md)** | You, if curious   | Rules for `compactionSummaryMode: "append"`.                                              |
| **[`docs/LOCAL-DIVERGENCE.md`](docs/LOCAL-DIVERGENCE.md)**   | Developers        | Detailed catalog of all architectural divergences and patch rules vs upstream.          |
| **[`LOCAL-MAINTENANCE.md`](LOCAL-MAINTENANCE.md)**           | Maintainers       | Sync workflow, workspace bootstrap, testing guidelines, and deployment procedures.        |

> **Note:** All docs except `README.md`, `CHANGELOG.md` (package root, read by `/blackhole changelog`), and `llms.txt` live under `docs/` — product docs (`architecture.md`, `CONFIG.md`, etc.); `archived_docs/` is local-only (gitignored).

---

## Credits

`pi-blackhole` started as a merge of two upstream projects but has since diverged significantly. The codebase still carries DNA from both:

- **[pi-vcc](https://github.com/sting8k/pi-vcc)** by @sting8k — algorithmic conversation compaction (the `compile()` pipeline, section extraction, recall core).
- **[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** by @elpapi42 — session-ledger-based observation/reflection capture, memory agents, ledger folding.

What blackhole adds and reworks on top:

- **Unified configuration** — one JSON file, not two.
- **Per-worker model fallback chains** with persisted cooldowns that survive Pi restarts.
- **Manual flush mode** — `compaction: "manual"` saves observations to per-session disk buffers.
- **Conflict resolution** — OM hooks into vcc's compaction, not Pi's default.
- **Memory toggle** (`/blackhole om-off` / `/blackhole om-on`) — disable the memory layer without uninstalling.
- **Per-session pending state** — isolated per-session JSON files, no cross-session contamination.
- **Custom provider bridge** — consolidation agents loaded via jiti can still use provider stream functions registered by other extensions.
- **Retryable error detection with per-model cooldowns** — models that fail get cooled down, fallbacks tried automatically, 30-second retry gate prevents spam.
- **Improved observer/reflector/dropper prompts** — each heavily customized with detailed extraction rules, relevance guidance, and error handling.
- **OM-recall coupling** — when expanding session entries via `recall`, related observations and reflections are automatically shown.
- **Thinking level support** — per-model `thinking` field for reasoning effort control, including `max` where supported by the provider.

## License

MIT
