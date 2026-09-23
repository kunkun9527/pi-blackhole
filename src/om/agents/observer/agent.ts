/**
 * Observer agent — uses agentLoop to distill conversation chunks into observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/observer/agent.ts)
 * Modified by pi-vcc-om: detects agent_end stopReason="error" in the stream
 * and throws if the API errored without collecting any tool results.
 * This allows the consolidation pipeline to fall back to alternative models.
 */
import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { buildAgentContext } from "../agent-context.js";
import { createTurnCap, type LegacyTurnCapOption } from "../turn-cap.js";
import {
  createBridgeStreamFn,
  createProviderFetch,
  type ProviderFetchOption,
} from "../../provider-stream.js";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../ledger/index.js";
import { estimateStringTokens } from "../../tokens.js";
import { agentCompletionError, initialInputLimit } from '../../input-budget.js';
import { agentInputLimit, agentInputTokens, boundedContext, budgetedStream, InputBudgetError, userPrompt, type InputBudgetOptions } from '../../input-budget.js';
import { serializeSourceAddressedBranchEntries, type RenderableEntry } from '../../serialize.js';

interface RunObserverArgs extends InputBudgetOptions {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  priorReflections: string[];
  priorObservations: string[];
  chunk: string;
  allowedSourceEntryIds: string[];
  /** Entry id -> local display timestamp for the chunk's source entries; used to
   *  timestamp observations programmatically from their cited evidence. */
  sourceEntryTimestamps?: Record<string, string>;
  signal?: AbortSignal;
  agentLoop?: typeof agentLoop;
  /** Optional custom stream function bypassing agentLoop's default streamSimple.
   *  Used by the Symbol.for bridge to access native pi-ai provider registrations
   *  from jiti-loaded consolidation agents. */
  streamFn?: (model: any, context: any, options: any) => any;
  maxTurns?: number;
  thinkingLevel?: ModelThinkingLevel;
  providerIdleTimeoutMs?: number;
  /** Model registry for streamSimple resolution (custom providers, OAuth). */
  modelRegistry?: any;
  /**
   * Pi session id, forwarded through standard stream options
   * (`SimpleStreamOptions.sessionId`). agentLoop spreads the full config into
   * stream opts, so the bridge can derive provider-required headers (e.g.
   * OpenCode `x-opencode-session`) without per-provider branching upstream.
   */
  sessionId?: string;
}

const RelevanceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
  observations: Type.Array(
    Type.Object({
      content: Type.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Exact source entry ids from the chunk that directly support this observation. " +
          "Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
      }),
    }),
    {
      description: "Batch of new observations. May be empty only if the tool is not called at all.",
    },
  ),
});

const OBSERVER_TOOL_DESCRIPTION = 'Record a batch of observations from the supplied source entries. Continue until the chunk is covered, then confirm completion.';
function observerText(chunk: string, reflections: readonly string[], observations: readonly string[]): string {
  return `CURRENT REFLECTIONS:\n${reflections.join('\n') || '(none yet)'}\n\nCURRENT OBSERVATIONS:\n${observations.join('\n') || '(none yet)'}\n\nCompress the following new conversation chunk into observations. Do not restate facts already present in the supplied prior context. Call record_observations until the chunk is fully covered, then confirm completion.\n\nNEW CONVERSATION CHUNK:\n${chunk}`;
}
/** Choose an oldest-first contiguous prefix using the exact initial prompt layout. */
export function prepareObserverInput(entries: RenderableEntry[], model: any, options: InputBudgetOptions, reflections: string[], observations: string[]) {
  const limit = agentInputLimit(model, options, 40_000);
  const contextCap = Math.floor(limit * 0.1);
  const priorReflections = [boundedContext(reflections, contextCap)].filter(Boolean);
  const priorObservations = [boundedContext(observations, contextCap)].filter(Boolean);
  const tools = [{name:'record_observations',description:OBSERVER_TOOL_DESCRIPTION,parameters:RecordObservationsSchema}];
  const fits = (count: number) => agentInputTokens(OBSERVER_SYSTEM, tools, userPrompt(observerText(serializeSourceAddressedBranchEntries(entries.slice(0,count)).text, priorReflections, priorObservations))) <= initialInputLimit(limit);
  if (entries.length && !fits(1)) {
    // Source coverage takes priority over optional prior context.
    priorReflections.splice(0, priorReflections.length, '(prior context omitted)');
    priorObservations.splice(0, priorObservations.length);
  }
  if (entries.length && !fits(1)) throw new InputBudgetError(`Observer: first source entry ${entries[0]?.id} cannot fit initial input budget ${initialInputLimit(limit)} (completion headroom reserved); original retained and coverage not advanced.`);
  let low = 0, high = entries.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
  return {...serializeSourceAddressedBranchEntries(entries.slice(0,low)), priorReflections, priorObservations};
}

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

/**
 * Derive an observation timestamp from its supporting source entries instead of
 * trusting an LLM-reported time. Uses the LATEST supporting entry (the moment the
 * cited evidence was complete); falls back to the current local time when the
 * chunk carries no usable timestamps. Lexicographic comparison is correct for
 * the fixed-width "YYYY-MM-DD HH:MM" format; placeholder timestamps ("????-??-??")
 * are ignored.
 */
function deriveObservationTimestamp(
  sourceEntryIds: readonly string[],
  sourceEntryTimestamps: Record<string, string> | undefined,
): string {
  let latest: string | undefined;
  if (sourceEntryTimestamps) {
    for (const id of sourceEntryIds) {
      const t = sourceEntryTimestamps[id];
      if (!t || t.startsWith("?")) continue;
      if (!latest || t > latest) latest = t;
    }
  }
  return latest ?? nowTimestamp();
}

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeSourceEntryIds(
  sourceEntryIds: readonly string[] | undefined,
  allowedSourceEntryIds: readonly string[],
): string[] | undefined {
  if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
  const allowedOrder = new Map<string, number>();
  for (let i = 0; i < allowedSourceEntryIds.length; i++)
    allowedOrder.set(allowedSourceEntryIds[i], i);

  // Filter out invalid/unknown IDs instead of rejecting the entire batch.
  // Matches the dropper's normalizeDropObservationIds pattern: one hallucinated
  // ID from the LLM should not discard valid observations.
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const id of sourceEntryIds) {
    if (!allowedOrder.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  if (valid.length === 0) return undefined;
  return valid.sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

/** Result returned by runObserver when no observations are recorded. */
export type ObserverEmptyReason =
  | { kind: "no_new_content" } // model ran but nothing worth recording
  | { kind: "tool_not_called" } // model didn't call record_observations at all
  | { kind: "all_rejected"; count: number } // tool called but all sourceEntryIds invalid
  | { kind: "all_duplicates"; count: number } // tool called but all already seen
  | { kind: "empty_array"; count: number }; // tool called but returned empty observations array

export interface ObserverResult {
  observations: Observation[] | undefined;
  emptyReason?: ObserverEmptyReason;
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverResult> {
  const {
    model,
    apiKey,
    headers,
    env,
    priorReflections,
    priorObservations,
    chunk,
    allowedSourceEntryIds,
    signal,
  } = args;
  const conversation = chunk.trim();
  if (!conversation) return { observations: undefined };

  const accumulated = new Map<string, Observation>();
  let toolCalled = false;
  let totalAdded = 0;
  let totalDuplicates = 0;
  let totalRejected = 0;
  let totalProposed = 0;

  const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
    name: "record_observations",
    label: "Record observations",
    description: OBSERVER_TOOL_DESCRIPTION,
    parameters: RecordObservationsSchema,
    execute: async (_id, params: RecordObservationsArgs) => {
      toolCalled = true;
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const obs of params.observations) {
        totalProposed++;
        const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
        if (!sourceEntryIds) {
          rejected++;
          continue;
        }
        const content = truncateRecordContent(obs.content);
        const id = hashId(content);
        if (accumulated.has(id)) {
          duplicates++;
          continue;
        }
        accumulated.set(id, {
          id,
          content,
          timestamp: deriveObservationTimestamp(sourceEntryIds, args.sourceEntryTimestamps),
          relevance: obs.relevance as Relevance,
          sourceEntryIds,
          tokenCount: estimateStringTokens(content),
        });
        added++;
      }
      totalAdded += added;
      totalDuplicates += duplicates;
      totalRejected += rejected;
      const rejectedPart =
        rejected > 0
          ? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
          : "";
      const ack =
        `Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
        (duplicates > 0
          ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).`
          : ".") +
        rejectedPart +
        ` Total so far this run: ${accumulated.size}. ` +
        `Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
      return {
        content: [{ type: "text", text: ack }],
        details: { added, duplicates, rejected, total: accumulated.size },
      };
    },
  };

  const limit = agentInputLimit(model, args, 40_000);
  const userText = observerText(conversation, priorReflections, priorObservations);
  if (agentInputTokens(OBSERVER_SYSTEM, [recordObservations], userPrompt(userText)) > limit) {
    throw new InputBudgetError(`Observer input exceeds budget ${limit}; original retained and coverage not advanced.`);
  }

  const prompts: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];

  const context = buildAgentContext(OBSERVER_SYSTEM, [recordObservations as AgentTool<any>]);

  const reasoning = (model as { reasoning?: unknown }).reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  const config: AgentLoopConfig & ProviderFetchOption & LegacyTurnCapOption = {
    model,
    apiKey,
    headers,
    env,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(providerFetch ? { fetch: providerFetch } : {}),
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs as Message[],
    toolExecution: "sequential",
    ...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    ...(effectiveMaxTurns !== undefined ? createTurnCap(effectiveMaxTurns) : {}),
  };

  const loop = args.agentLoop ?? agentLoop;
  // ── Bridge stream function ──
  // Consolidation agents run via jiti (moduleCache: false) which creates a separate
  // pi-ai instance whose apiProviderRegistry lacks custom providers registered by
  // other extensions (e.g., claude-bridge). The bridge looks up streamSimple functions
  // via modelRegistry (host-composed facade → registered provider config → global map).
  const bridgeStreamFn = createBridgeStreamFn(streamSimple, args.modelRegistry);
  const streamFn = budgetedStream(args.streamFn ?? bridgeStreamFn, limit);
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError: string | undefined;
  for await (const event of stream) {
    // Drain events; the tool's execute already collects records.
    if (event.type === "agent_end") {
      const msgs = ((event as any).messages || []) as Array<{
        stopReason?: string;
        errorMessage?: string;
      }>;
      agentError = agentCompletionError(msgs, signal);
    }
  }
  await stream.result();
  if (streamFn.error) throw streamFn.error;
  if (signal?.aborted) throw new Error('Observer aborted; coverage not advanced');

  if (agentError) {
    throw new Error(`Observer API error: ${agentError}`);
  }

  if (accumulated.size === 0) {
    // Determine why no observations were recorded
    let emptyReason: ObserverEmptyReason;
    if (!toolCalled) {
      emptyReason = { kind: "tool_not_called" };
    } else if (totalRejected > 0 && totalAdded === 0) {
      emptyReason = { kind: "all_rejected", count: totalRejected };
    } else if (totalDuplicates > 0 && totalAdded === 0) {
      emptyReason = { kind: "all_duplicates", count: totalDuplicates };
    } else if (totalProposed === 0) {
      emptyReason = { kind: "empty_array", count: 0 };
    } else {
      emptyReason = { kind: "no_new_content" };
    }
    return { observations: undefined, emptyReason };
  }

  return { observations: Array.from(accumulated.values()) };
}
