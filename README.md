# pi-blackhole

**Deterministic compaction + session-aware observational memory for [Pi](https://github.com/earendil-works/pi) — in one unified extension.**

`/blackhole` replaces Pi's LLM-based `/compact` with an algorithmic structural summary — fast, zero-cost. Three background workers (Observer, Reflector, Dropper) capture durable facts and decisions that survive across compactions. Per-worker model fallback chains with persisted cooldowns. Manual flush mode. One JSON file to configure it all.

> [!NOTE]
> **Community Fork Notice**: This repository is a community-maintained fork of [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik), tracking upstream `dev` (baseline v0.5.9). All core architectural design and implementation belong to the original author. This fork introduces targeted enhancements for **CJK (Chinese/Japanese/Korean) multilingual precision**, **FIFO long-session memory durability**, and **defensive context safety**.  
> **关于本 Fork**：本仓库基于原版 [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole) 维护，核心架构归原作者所有。在保持与上游完全兼容的前提下，重点增强了 **CJK 多语言精度**、**长会话 FIFO 记忆完整性** 与 **上下文防御性预算安全**。

---

## Install

```bash
# Install this fork (with CJK & Long-Session Enhancements)
# Note: Requires npmCommand in ~/.pi/agent/settings.json, e.g.: "npmCommand": ["npm"]
pi install git:github.com/kunkun9527/pi-blackhole

# Or install official upstream release from npm
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

## Fork Enhancements at a Glance / 特性概览

This edition tracks upstream `dev` (baseline v0.5.9) while hardening key areas for long engineering runs and non-English environments:

| Capability / 核心能力 | Upstream Baseline / 上游原版 | This Fork (CJK & Long-Session Edition) / 本 Fork 增强 |
|---|---|---|
| **CJK Token Accounting** | Uniform ~1 token/char heuristic | Conservative Unicode model (~1.5 tokens/char, 4 for non-BMP) to prevent context exhaustion |
| **Search & Recall** | Space-delimited token matching | Native `Intl.Segmenter` + bi-gram indexing for Asian text; 12,000 token response ceiling |
| **Observer Backlog** | Newest-first single-chunk slice | Chronological FIFO queue draining (`drain=true`) with atomic input budgeting (`src/om/input-budget.ts`) |
| **Record Deduplication** | Fuzzy Levenshtein / SimHash clustering | Strict exact-match deduplication to preserve similar code blocks and fine-grained CJK directives |
| **Pi 0.87+ Lifecycle** | Native `agentContext` & `createTurnCap` | Extended with `midRunCompaction: "resume"` for smooth inline tool execution loops |

<details>
<summary><b>Technical Highlights & Implementation Details / 技术实现细节（点击展开）</b></summary>

### 1. CJK & Multilingual Precision (中文与多语言深度优化)
- **Conservative Token Accounting**: Estimates CJK characters at ~1.5 tokens/char and non-BMP symbols at 4 tokens. Eliminates the risk of long non-English sessions silently exhausting hard context limits prior to compaction triggering.  
  *(针对 CJK 字符采用约 1.5 token/字更保守合理的估算规则，消除中文长文本因低估 token 在压缩前挤爆硬上下文上限的隐患)*
- **Native Semantic Tokenization**: Integrates native `Intl.Segmenter` and bi-gram indexing into `recall` search for accurate keyword discovery and context snippet location without external binary dependencies.  
  *(`recall` 检索集成原生 `Intl.Segmenter` 分词与双字索引，支持中文关键词搜索与上下文定位，标点断句贴合中文习惯)*
- **Directive & Goal Tracking**: Robustly parses multi-clause Chinese instructions, conditional rules ("如果..."), and negative constraints ("不要..."), accurately recognizing status transitions ("已修复", "仍然报错") to isolate independent sub-goals.  
  *(精确解析中文复合指令、条件句与否定句；独立追踪子目标状态变迁，防止清除未决问题)*

### 2. Long-Session Memory Durability (长会话记忆完整性保障)
- **FIFO Chronological Draining**: When observer backlog exceeds a single chunk (e.g. 50k tokens), processes unobserved entries in chronological order (`drain=true`) until fully caught up, ensuring early architectural decisions and debugging insights are preserved during extended multi-tool sessions.  
  *(重构为从旧到新 FIFO 分批处理积压，多轮连续排空直至追齐进度，保障长任务早期关键决策与排查记录完整留存)*
- **Atomic Input Budgeting**: Introduces atomic request budgeting (`src/om/input-budget.ts`). Pre-flights model input limits and cleanly rolls back state on provider aborts or stream errors, preventing phantom coverage advances.  
  *(引入原子输入预算保护，在异常或超限时原子回滚，不造成记忆空洞或虚假推进)*

### 3. Defensive Context Safety (上下文防御性加固)
- **Dual Recall Ceilings**: Enforces both character and estimated token caps (`DEFAULT_RECALL_RESPONSE_MAX_TOKENS = 12000`) on `#N:text` and `#N:path` drill-downs, guaranteeing that inspecting large files or logs cannot flood the active conversation window.  
  *(引入字符与 12,000 tokens 双重响应上限，保证检索展开不会一次性撑爆上下文窗口)*
- **Exact Identity Matching**: Employs strict identity matching for session records rather than fuzzy clustering, protecting subtle code variations and precise phrasing from accidental merge or deletion.  
  *(仅对完全相同的原文进行去重，杜绝相似代码片段或语义接近的记录被算法误合并、误删)*

> **Detailed Specifications / 详细技术规范**:  
> See [**`docs/LOCAL-DIVERGENCE.md`**](docs/LOCAL-DIVERGENCE.md) for the complete divergence list (D1–D12; D11 merged upstream in v0.5.9) and merge rules, and [**`LOCAL-MAINTENANCE.md`**](LOCAL-MAINTENANCE.md) for the sync and maintenance workflow.  
> 完整技术实现与维护规则请参阅 [**`docs/LOCAL-DIVERGENCE.md`**](docs/LOCAL-DIVERGENCE.md) 与 [**`LOCAL-MAINTENANCE.md`**](LOCAL-MAINTENANCE.md)。

</details>
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

Every recall response is capped at `recallResponseMaxChars` (default 48,000 ≈ 12k tokens). Search snippet lines, expanded entries, drill-down bodies, and related observation bodies are clipped to keep a single huge stored message from flooding the context; a truncation marker names the omitted entries and how to continue (`#N:text` / `#N:path` / `page:N`). A capped drill-down cuts only at line boundaries and names the first line it did not show, so the next `#N:path:offset:limit` call continues there without skipping or repeating lines.

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
