/** Independent character and estimated-token limits for recall responses. */
import { estimateStringTokens } from "../om/tokens.js";
export const DEFAULT_RECALL_RESPONSE_MAX_CHARS = 48_000;
export const DEFAULT_RECALL_RESPONSE_MAX_TOKENS = 12_000;
export const EXPAND_FLOOR_CHARS = 2_000;
export const EXPAND_ENTRY_OVERHEAD = 200;

export function expandAllocation(count: number, budget: number): number {
  if (count <= 0 || budget <= 0) return 0;
  const usable = Math.max(0, budget - count * EXPAND_ENTRY_OVERHEAD);
  const share = Math.floor(usable / count);
  return count * EXPAND_FLOOR_CHARS <= usable ? Math.max(share, EXPAND_FLOOR_CHARS) : share;
}

export interface CapRecallBlocksInput {
  header: string;
  entryBlocks: string[];
  tailBlocks?: string[];
  /** Character ceiling; 0/negative = disabled, independent of tokenBudget. */
  budget: number;
  /** Estimated-token ceiling; 0/negative = disabled. */
  tokenBudget?: number;
  continuation?: string;
}
export interface CapRecallBlocksResult {
  text: string;
  omittedEntries: number;
  totalEntries: number;
  capped: boolean;
}

function fits(text: string, chars: number, tokens: number): boolean {
  return (chars <= 0 || text.length <= chars) && (tokens <= 0 || estimateStringTokens(text) <= tokens);
}

/** Code-point-safe prefix, including budget checks on the final rendered text. */
function prefix(text: string, chars: number, tokens: number): string {
  const points = Array.from(text);
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(points.slice(0, mid).join(""), chars, tokens)) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join("");
}

/** Drop trailing blocks; reserve headers, separators and the continuation note. */
export function capRecallBlocks(input: CapRecallBlocksInput): CapRecallBlocksResult {
  const { header, entryBlocks, tailBlocks = [], budget, tokenBudget = DEFAULT_RECALL_RESPONSE_MAX_TOKENS, continuation = "" } = input;
  const totalEntries = entryBlocks.length;
  const entries = [...entryBlocks], tails = [...tailBlocks];
  const join = (parts: string[]) => parts.filter(Boolean).join("\n\n");
  const original = join([header, ...entries, ...tails]);
  if (fits(original, budget, tokenBudget)) return {text: original, omittedEntries: 0, totalEntries, capped: false};
  while (true) {
    const omittedEntries = totalEntries - entries.length;
    const note = `[recall capped; ${omittedEntries}/${totalEntries} entries omitted. ${continuation || "Use a smaller page or #N:text:offset:limit."}]`;
    const text = join([header, ...entries, ...tails, note]);
    if (fits(text, budget, tokenBudget)) return {text, omittedEntries, totalEntries, capped: true};
    if (tails.length) { tails.pop(); continue; }
    if (entries.length) { entries.pop(); continue; }
    // Tiny budgets cannot preserve even the header and note. Never exceed them.
    return {text: prefix(join([note, header]), budget, tokenBudget), omittedEntries, totalEntries, capped: true};
  }
}

/** For drill-down text: retain a bounded excerpt and an explicit paging hint. */
export function capRecallText(text: string, budget: number, tokenBudget: number, hint: string): string {
  if (fits(text, budget, tokenBudget)) return text;
  const note = `\n\n[recall capped; ${hint}]`;
  if (!fits(note, budget, tokenBudget)) return prefix(note.trim(), budget, tokenBudget);
  const charRoom = budget > 0 ? Math.max(0, budget - note.length) : 0;
  const tokenRoom = tokenBudget > 0 ? Math.max(0, tokenBudget - estimateStringTokens(note)) : 0;
  if ((budget > 0 && charRoom === 0) || (tokenBudget > 0 && tokenRoom === 0)) return note;
  return prefix(text, charRoom, tokenRoom) + note;
}
