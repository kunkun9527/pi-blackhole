import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { estimateEntryTokens, estimateStringTokens } from './tokens.js';
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from './model-budget.js';

/** A local budget refusal is not an API failure and must never advance coverage. */
export class InputBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'InputBudgetError'; }
}
export interface InputBudgetOptions {
  inputMaxTokens?: number;
  contextWindow?: number;
}
export function agentInputLimit(model: any, options: InputBudgetOptions, fallback: number): number {
  const window = options.contextWindow ?? model.contextWindow ?? 128_000;
  // Reserve the actual configured output allowance and serialization safety margin.
  const room = Math.floor(window - boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS) - 1024);
  return Math.max(0, Math.min(options.inputMaxTokens ?? fallback, room));
}

/** Leave input headroom for tool calls/results and the completion turn. */
export function initialInputLimit(limit: number): number {
  return Math.floor(limit * 0.8);
}

/** Measure the final prompt, including system text, tool schemas and message wrappers. */
export function agentInputTokens(systemPrompt: string, tools: readonly any[], messages: readonly any[]): number {
  const schemas = tools.map(({name, description, parameters}) => ({name, description, parameters}));
  return estimateStringTokens(systemPrompt) + estimateStringTokens(JSON.stringify(schemas)) + 128 +
    messages.reduce((sum, message) => sum + 16 + estimateEntryTokens({type:'message',message}), 0);
}
export function userPrompt(text: string): any[] {
  return [{role:'user',content:[{type:'text',text}],timestamp:Date.now()}];
}

/** Context is optional, never source coverage. Keep whole lines with an explicit omission marker. */
export function boundedContext(lines: readonly string[], maxTokens: number): string {
  if (maxTokens <= 0 || !lines.length) return '';
  const full = lines.join('\n');
  if (estimateStringTokens(full) <= maxTokens) return full;
  const marker = '[Prior context omitted to fit input budget; source records remain stored.]';
  if (estimateStringTokens(marker) > maxTokens) return '';
  const kept: string[] = [];
  for (const line of lines) {
    const next = [...kept,line,marker].join('\n');
    if (estimateStringTokens(next) <= maxTokens) kept.push(line);
  }
  return [...kept,marker].join('\n');
}

/** Plan every batch before the first model call. Never clip, skip or reorder source items. */
export function planInputBatches<T>(items: readonly T[], fits: (batch:T[])=>boolean, stage: string): T[][] {
  const batches:T[][]=[];
  let batch:T[]=[];
  for (const item of items) {
    if (fits([...batch,item])) { batch.push(item); continue; }
    if (!fits([item])) throw new InputBudgetError(`${stage}: one source item cannot fit the input budget; original retained and coverage not advanced.`);
    if (batch.length) batches.push(batch);
    batch=[item];
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Hard per-turn ceiling: the model window minus output and safety reserve.
 * The configured `*InputMaxTokens` only sizes the initial source batch (see
 * `initialInputLimit`); tool calls and receipts may legitimately grow later
 * turns past it, and failing them would re-fail the same chunk every cycle.
 */
export function agentContextLimit(model: any, options: InputBudgetOptions): number {
  return agentInputLimit(model, { contextWindow: options.contextWindow }, Number.POSITIVE_INFINITY);
}

/**
 * Recheck every agent-loop turn against the model window before it reaches the
 * provider. A refusal is returned as an error stream, never thrown: pi 0.87 runs
 * the loop as `void runAgentLoop(...)` without a catch, so a throw here becomes
 * an unhandled rejection that terminates the host process. The loop then ends
 * with `stopReason: "error"` and the caller rethrows `guarded.error`.
 */
export function budgetedStream(stream: (...args:any[])=>any, limit:number) {
  const guarded: ((...args:any[])=>any) & {error?:InputBudgetError} = (model:any, context:any, options:any) => {
    const tokens=agentInputTokens(context.systemPrompt ?? '',context.tools ?? [],context.messages ?? []);
    if (tokens>limit) {
      guarded.error = new InputBudgetError(`Agent input estimate ${tokens} exceeds context budget ${limit}; original retained and coverage not advanced.`);
      return refusalStream(model, guarded.error.message);
    }
    return stream(model,context,options);
  };
  return guarded;
}

function refusalStream(model: any, errorMessage: string) {
  const message: AssistantMessage = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage, timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'error', reason: 'error', error: message });
  stream.end(message);
  return stream;
}

/**
 * Interrupted/tool-limit responses do not prove full source coverage.
 *
 * `completedByTool`: the final tool batch returned `terminate` (upstream 0.5.9
 * `complete=true` early stop). pi's loop then ends right after that tool result,
 * so the last assistant message legitimately carries `stopReason: "toolUse"`.
 * Only that case is accepted; error/aborted/length still fail.
 */
export function agentCompletionError(
  messages: readonly any[],
  signal?: AbortSignal,
  completedByTool = false,
): string | undefined {
  if (signal?.aborted) return 'aborted';
  const last = [...messages].reverse().find(message => typeof message?.stopReason === 'string');
  if (last?.stopReason === 'toolUse' && completedByTool) return undefined;
  if (last && ['error','aborted','length','toolUse'].includes(last.stopReason)) {
    return last.errorMessage ?? `Incomplete agent response (${last.stopReason}); coverage not advanced.`;
  }
  return undefined;
}
