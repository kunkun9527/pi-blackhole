/**
 * Recall response budget — bounds the total text of a single recall tool
 * response so one huge stored message cannot flood the agent's context
 * (issue #83).
 *
 * Local policy (D8): independent character (`recallResponseMaxChars`) and
 * estimated-token (`recallResponseMaxTokens`) ceilings; 0/negative disables
 * only that ceiling.
 */

import { clip } from "./content.js";
import { DRILLDOWN_PAGE_LINES, type DrillDownPaging } from "./drill-down.js";
import { estimateStringTokens } from "../om/tokens.js";

/** Fallback used when a recall tool is registered without a runtime/config. */
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

export interface CapDrillDownTextInput {
  /** Rendered drill-down output, before the budget cap. */
  text: string;
  /** Paging coordinates of the rendered body, when the expansion produced one. */
  paging?: DrillDownPaging;
  /** Entry index the drill-down query targeted. */
  index: number;
  /** Path pattern the query targeted, echoed back verbatim in the hint. */
  pathPattern: string;
  /** Response budget in characters. 0/negative = unbounded. */
  maxChars: number;
  /** Local D8: estimated-token ceiling. 0/negative/unset = unbounded. */
  maxTokens?: number;
}

const countNewlines = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
};

/** First body character: just past the header's last newline. */
function bodyStartIndex(text: string, headerNewlines: number): number {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      seen++;
      if (seen === headerNewlines) return i + 1;
    }
  }
  return text.length;
}

/**
 * Clip `text` to `max` characters, stopping only at a line boundary: the cut
 * ends right after a newline, so every shown body line is whole and the
 * continuation resumes at exactly the next line — nothing skipped, nothing
 * re-read. Falls back to {@link clip} only when the window contains no newline
 * at all (a header that alone exceeds the budget).
 */
function clipAtLineBoundary(text: string, max: number): string {
  if (max <= 0) return "";
  const nl = text.lastIndexOf("\n", max - 1);
  if (nl < 0) return clip(text, max);
  return text.slice(0, nl + 1);
}

/**
 * Body lines the cut left fully visible. `cut` always ends at a line boundary
 * (or inside the header), so complete lines are the newlines it contains minus
 * the header's; footer newlines can inflate the count, hence the clamp to
 * `shownLines`.
 */
function visibleBodyLines(paging: DrillDownPaging, cut: string): number {
  const complete = countNewlines(cut) - paging.headerNewlines;
  const shown = Math.max(0, Math.min(paging.shownLines, paging.totalLines - paging.startLine));
  return Math.max(0, Math.min(shown, complete));
}

function drillDownCapNote(input: CapDrillDownTextInput, cut: string): string {
  const { paging, index, pathPattern, maxChars } = input;
  const limitLabel =
    maxChars > 0 ? `${maxChars} characters` : `${input.maxTokens ?? 0} estimated tokens`;
  const head = `--- recall response capped at ${limitLabel}; `;
  if (!paging) {
    return `\n\n${head}re-request a narrower range with #${index}:${pathPattern}:offset:limit ---`;
  }
  const visible = visibleBodyLines(paging, cut);
  if (visible === 0) {
    // The cut never left a whole body line: either the header alone ate the
    // budget, or the first body line is longer than what is left of it.
    if (cut.length < bodyStartIndex(input.text, paging.headerNewlines)) {
      return `\n\n${head}no content fit the budget — request one line with #${index}:${pathPattern}:${paging.startLine}:1 ---`;
    }
    const next = paging.startLine + 1;
    if (next >= paging.totalLines) {
      return `\n\n${head}no further lines to page — use a regex query to target a region ---`;
    }
    const limit = Math.min(DRILLDOWN_PAGE_LINES, paging.totalLines - next);
    return `\n\n${head}the line at offset ${paging.startLine} does not fit the budget; continue at #${index}:${pathPattern}:${next}:${limit} ---`;
  }
  const nextOffset = paging.startLine + visible;
  const remaining = paging.totalLines - nextOffset;
  if (remaining <= 0) {
    return `\n\n${head}no further lines to page — use a regex query to target a region ---`;
  }
  const limit = Math.min(DRILLDOWN_PAGE_LINES, remaining);
  return `\n\n${head}continue at #${index}:${pathPattern}:${nextOffset}:${limit} ---`;
}

/**
 * Cap a drill-down response to `maxChars` and append a hint the caller can act
 * on directly: with paging coordinates it names the exact line the cap did not
 * show (`#3:src/a.ts:412:30`), so the next call continues there. The cut only
 * ever lands on a line boundary, so following the hint neither skips nor
 * re-reads content. The hint and the clip reserve each other's space, so the
 * result never exceeds `maxChars`.
 */
export function capDrillDownText(input: CapDrillDownTextInput): string {
  const { text, maxChars } = input;
  const maxTokens = input.maxTokens ?? 0;
  if (fits(text, maxChars, maxTokens)) return text;

  // Local D8: the window must satisfy both ceilings. Token room is converted
  // to a character window by the code-point-safe prefix search, then the
  // upstream line-boundary cut applies inside that window.
  const windowFor = (note: string): number => {
    const chars = maxChars > 0 ? maxChars - note.length : 0;
    const tokens = maxTokens > 0 ? maxTokens - estimateStringTokens(note) : 0;
    if ((maxChars > 0 && chars <= 0) || (maxTokens > 0 && tokens <= 0)) return 0;
    // Every character costs >= 0.25 estimated tokens, so no fitting prefix is
    // longer than 4 chars per token; bound the search before splitting code points.
    const bound = Math.min(
      text.length,
      chars > 0 ? chars + 1 : Infinity,
      tokens > 0 ? tokens * 4 + 16 : Infinity,
    );
    const high = bound > 0 ? text.charCodeAt(bound - 1) : 0;
    const safe = bound < text.length && high >= 0xd800 && high <= 0xdbff ? bound - 1 : bound;
    return prefix(text.slice(0, safe), chars, tokens).length;
  };
  const noteOnly = (note: string): string => prefix(note.trim(), maxChars, maxTokens);

  // The hint's length depends on the resume numbers, and the resume numbers
  // depend on where the cut lands — which depends on the reserved hint length.
  // Iterate to a fixed point; each round can only shift the cut by the hint's
  // own length, so this settles immediately in practice.
  let note = "";
  for (let round = 0; round < 8; round++) {
    const allowed = windowFor(note);
    if (allowed <= 0 && note) return noteOnly(note);
    const next = drillDownCapNote(input, clipAtLineBoundary(text, allowed));
    if (next === note) break;
    note = next;
  }
  const allowed = windowFor(note);
  if (allowed <= 0) return noteOnly(note);
  const out = clipAtLineBoundary(text, allowed) + note;
  return fits(out, maxChars, maxTokens) ? out : noteOnly(note);
}
