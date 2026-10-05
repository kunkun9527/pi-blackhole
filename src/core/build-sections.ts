/**
 * Section building — parses normalized blocks into structured sections.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/build-sections.ts)
 * Modified by pi-blackhole:
 * - Files And Changes also attributes files from raw session messages via
 *   the file-touch collector (src/extract/file-touch.ts), covering anchor-
 *   based edit tools and bash mutations that PATH_KEYS matching cannot see.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps, NormalizedBlock } from "../types";
import { clip, firstLine, nonEmptyLines } from "./content";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles, formatFileList } from "../extract/files";
import { collectFilesTouched } from "../extract/file-touch";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  /** Raw pre-conversion session messages — enables file-touch attribution. */
  messages?: Message[];
  /** Working directory for relative-path merging in file-touch attribution. */
  cwd?: string;
  /** Pi's own file-op seed lists (read/written/edited). */
  fileOps?: FileOps;
  /** Git working-tree tags (abs path → "staged"/"new"/…), see src/extract/git-status.ts. */
  gitTags?: Map<string, string>;
}

const OUTSTANDING_CLIP = 200;
const COMMAND_CLIP = 80;

/** Lines that say a tool failed without saying why. */
const UNINFORMATIVE_ERROR_LINE_RE =
  /^(?:\(no output\)|Traceback \(most recent call last\):?|(?:Command )?(?:exited|failed) with (?:exit )?code -?\d+\.?|exit(?: code| status)?\s*[=:]?\s*-?\d+)$/i;
const ERROR_LINE_RE =
  /error|exception|fail|fatal|not found|denied|invalid|cannot|can't|unable|no such|refused|timed? ?out|失败|错误|报错|无法|找不到|拒绝|超时/i;

/**
 * The line that most likely says why a tool failed: the last error-looking
 * line (a Python traceback ends with the exception), else the first
 * informative one. The first line alone was often stdout noise.
 */
const errorReason = (text: string): string | undefined => {
  const lines = nonEmptyLines(text)
    .map((line) => line.trim())
    .filter((line) => !UNINFORMATIVE_ERROR_LINE_RE.test(line));
  return lines.findLast((line) => ERROR_LINE_RE.test(line)) ?? lines[0];
};

/** Path-like tokens (`src/a.ts`, `/repo/b.md`) used to match an error to its retry. */
const pathTokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9_.$/-]*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}\b/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
};

/**
 * Local D18: Outstanding Context lists only tool errors that no later call
 * resolved. Prose (user or assistant sentences containing failure words) is
 * not scanned: in sampled summaries those bullets were mostly clause
 * fragments and already-settled discussion.
 */
const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  // An error retried successfully later in the window is resolved, not
  // outstanding. Bash errors extinguish only when the identical command
  // later succeeds — a different command succeeding says nothing about the
  // failure (e.g. tests fail, then `git status` works: the failure stands).
  // Other tools extinguish on a later success sharing a path-like token
  // with the error text (same file fixed); with no path tokens on either
  // side, same-tool success is enough.
  interface ErrorEntry {
    name: string;
    index: number;
    command?: string;
    paths: Set<string>;
    text: string;
  }
  const errors: ErrorEntry[] = [];
  const successes: { name: string; index: number; command?: string; paths: Set<string> }[] = [];
  const lastCallCommand = new Map<string, string>();
  blocks.forEach((b, index) => {
    if (b.kind === "tool_call") {
      if (b.name === "bash" && typeof b.args.command === "string") {
        lastCallCommand.set(b.name, b.args.command);
      }
      return;
    }
    if (b.kind !== "tool_result") return;
    if (b.isError) {
      errors.push({
        name: b.name,
        index,
        command: lastCallCommand.get(b.name),
        paths: pathTokens(b.text),
        text: b.text,
      });
    } else {
      successes.push({
        name: b.name,
        index,
        command: lastCallCommand.get(b.name),
        paths: pathTokens(b.text),
      });
    }
  });

  // Other tools extinguish on a later success sharing a path-like token
  // with the error text (same file fixed); only when neither side carries
  // any path token is same-tool success enough — a pathless success says
  // nothing about the file a path-bearing error mentions.
  const isExtinguished = (e: ErrorEntry): boolean =>
    successes.some((s) => {
      if (s.name !== e.name || s.index <= e.index) return false;
      if (e.name === "bash") return s.command !== undefined && s.command === e.command;
      if (e.paths.size > 0 || s.paths.size > 0) {
        return [...e.paths].some((p) => s.paths.has(p));
      }
      return true;
    });

  const outstanding: string[] = [];
  for (const e of errors) {
    if (isExtinguished(e)) continue;
    const reason = errorReason(e.text);
    const command = e.name === "bash" && e.command ? `\`${firstLine(e.command, COMMAND_CLIP)}\` ` : "";
    const line = `[${e.name}] ${command}${reason ? clip(reason, OUTSTANDING_CLIP) : "failed"}`;
    if (!outstanding.includes(line)) outstanding.push(line);
  }
  // Chronological; keep the most recent.
  return outstanding.slice(-5);
};

const formatFileActivity = (input: BuildSectionsInput): string[] => {
  // Lazy: the touch collector only runs at compaction time, never per tool call.
  const touched = input.messages ? collectFilesTouched(input.messages, input.cwd) : [];
  const act = extractFiles(input.blocks, input.fileOps, touched, input.gitTags, input.cwd);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const tagOf = (p: string): string => {
    const tag = act.gitTags?.get(p);
    return tag ? ` (${tag})` : "";
  };
  // Modified/Created render as one-per-line lists (up to 20 — the touched
  // set is the session's ground truth, worth preserving); Read stays a
  // comma-joined bullet capped at 10.
  const list = (set: Set<string>) => [...set].map((p) => `${p}${tagOf(p)}`);
  if (act.modified.size > 0) lines.push(formatFileList("Modified", list(act.modified), 20));
  if (act.created.size > 0) lines.push(formatFileList("Created", list(act.created), 20));
  if (act.read.size > 0) {
    const arr = list(act.read);
    lines.push(
      `Read: ${arr.slice(0, 10).join(", ")}${arr.length > 10 ? ` (+${arr.length - 10} more)` : ""}`,
    );
  }
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(extractPreferences(blocks), sessionGoal);
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(input),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections),
  };
};
