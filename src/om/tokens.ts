/**
 * Token estimation for serialized entries.
 *
 * Real assistant usage is preferred wherever the host has provided it. For
 * unmeasured text, the fallback keeps the old ASCII `chars / 4` estimate but
 * counts CJK letters more conservatively. This is a safety estimate, not a
 * replacement for a provider-specific tokenizer.
 */
import {
  calculateContextTokens,
  estimateTokens as estimateMessageTokens,
} from "@earendil-works/pi-coding-agent";

/** Deliberately conservative fallback for Han/Hiragana/Katakana/Hangul text. */
export const CJK_FALLBACK_TOKENS_PER_CHAR = 1.5;
export const ASCII_FALLBACK_CHARS_PER_TOKEN = 4;

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_PUNCT_RE = /[\u3000-\u303f\uff00-\uffef]/u;

/** Heuristic, not a tokenizer or guaranteed upper bound for every model. */
export function estimateStringTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point < 128) tokens += 1 / ASCII_FALLBACK_CHARS_PER_TOKEN;
    else if (point > 0xffff) tokens += 4; // emoji and rare supplementary ideographs
    else if (CJK_CHAR_RE.test(char)) tokens += CJK_FALLBACK_TOKENS_PER_CHAR;
    else if (CJK_PUNCT_RE.test(char)) tokens += 1;
    else tokens += Buffer.byteLength(char, "utf8");
  }
  return Math.ceil(tokens);
}

export function hasUsageData(msg: unknown): boolean {
  return getUsageTokens(msg) !== undefined;
}

/**
 * Extract real usage token count from an assistant message.
 *
 * Only trusted when the message is a real assistant response:
 * - role must be "assistant" (never toolResult — ToolResultMessage.usage
 *   reflects tool execution, not LLM context accounting)
 * - stopReason must not be "error" or "aborted" (failed turns carry
 *   misleading usage)
 *
 * Never throws; returns undefined when usage is missing, zero, or not finite.
 */
export function getUsageTokens(msg: unknown): number | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const record = msg as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  if (record.stopReason === "error" || record.stopReason === "aborted") return undefined;
  if (record.usage === undefined) return undefined;
  try {
    const tokens = calculateContextTokens(
      record.usage as Parameters<typeof calculateContextTokens>[0],
    );
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return undefined;
    return tokens;
  } catch {
    return undefined;
  }
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const record = message as Record<string, unknown>;
  if (record.role === "bashExecution") {
    return [record.command, record.output].filter((value) => typeof value === "string").join("\n");
  }
  if (record.role === "branchSummary" || record.role === "compactionSummary") {
    return typeof record.summary === "string" ? record.summary : "";
  }
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (block.type === "thinking" && typeof block.thinking === "string") return [block.thinking];
    if (block.type === "toolCall") {
      try { return [JSON.stringify(block.arguments) ?? ""]; } catch { return []; }
    }
    return [];
  }).join("\n");
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateStringTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((total, block) => {
      if (typeof block === "object" && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return total + estimateStringTokens(text);
      }
      return total;
    }, 0);
  }
  if (content !== undefined && content !== null) {
    try {
      return estimateStringTokens(JSON.stringify(content));
    } catch {
      return 0;
    }
  }
  return 0;
}

export function estimateEntryTokens(entry: {
  type: string;
  customType?: string;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
  data?: unknown;
}): number {
  // UI-only persisted copy: never feed it back into source pressure or memory.
  if (entry.type === "custom" && entry.customType === "blackhole-pre-compaction-output") return 0;
  if (entry.type === "message" && entry.message) {
    let hostEstimate = 0;
    try {
      hostEstimate = estimateMessageTokens(
        entry.message as Parameters<typeof estimateMessageTokens>[0],
      );
    } catch {
      // Fall through to the text estimate for malformed/unknown host messages.
    }
    // Add the Unicode correction; max(host, text) loses image/tool overhead.
    const text = messageText(entry.message);
    const safeHost = Number.isFinite(hostEstimate) ? Math.max(0, hostEstimate) : 0;
    return Math.max(
      estimateStringTokens(text),
      safeHost + Math.max(0, estimateStringTokens(text) - Math.ceil(text.length / 4)),
    );
  }
  if (entry.type === "custom_message" && entry.content !== undefined) {
    return estimateContentTokens(entry.content);
  }
  if (entry.type === "custom" && entry.data !== undefined) {
    return estimateContentTokens(entry.data);
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}
