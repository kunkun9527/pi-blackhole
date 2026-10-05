/**
 * Memory output language (local D14).
 *
 * The worker prompts are English and say nothing about language, so models
 * follow whatever the current chunk happens to be written in: a Chinese
 * session ends up with the same fact stored once in Chinese and once in
 * English. Workers in sessions where the user writes Chinese are told to
 * write memory in Simplified Chinese; other sessions are unchanged.
 */
import type { Entry } from "./ledger/index.js";

export type MemoryLanguage = "zh-Hans";

/** Recent user turns decide; older turns say little about the current session. */
const RECENT_USER_MESSAGES = 40;

function userText(entry: Entry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .map((part: { type?: unknown; text?: unknown }) =>
      part?.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

/**
 * Classify each recent user message as Chinese (any two Han characters) or
 * English (ten Latin letters, no Han); Chinese wins ties. Skill expansions and
 * code blocks are pasted material, not the user's own language.
 */
export function detectMemoryLanguage(entries: readonly Entry[]): MemoryLanguage | undefined {
  let chinese = 0;
  let english = 0;
  let seen = 0;
  for (let i = entries.length - 1; i >= 0 && seen < RECENT_USER_MESSAGES; i--) {
    const raw = userText(entries[i]!);
    if (raw === undefined) continue;
    seen++;
    const text = raw.replace(/<skill\b[\s\S]*?<\/skill>/g, "").replace(/```[\s\S]*?```/g, "");
    if ((text.match(/\p{Script=Han}/gu)?.length ?? 0) >= 2) chinese++;
    else if ((text.match(/[A-Za-z]/g)?.length ?? 0) >= 10) english++;
  }
  return chinese > 0 && chinese >= english ? "zh-Hans" : undefined;
}

const LANGUAGE_RULES: Record<MemoryLanguage, string> = {
  "zh-Hans":
    "Write every content string in Simplified Chinese; keep paths, commands, identifiers, config keys, error messages and quoted wording verbatim. " +
    "Never restate in Chinese a fact already recorded in English.",
};

export function withMemoryLanguage(system: string, language: MemoryLanguage | undefined): string {
  return language ? `${system}\n\n${LANGUAGE_RULES[language]}` : system;
}
