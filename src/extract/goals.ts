import type { NormalizedBlock } from "../types";
import { nonEmptyLines, clip } from "../core/content";
import { collapseSkillLines } from "../core/skill-collapse";

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b|(?:改(?:一下|成|为)|换成|转而|现在(?:我)?(?:想|要|希望|需要)|接下来|新的?(?:任务|目标)|不再(?:做|使用|处理))/iu;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b|(?:修复|实现|添加|创建|构建|重构|调试|调查|更新|删除|迁移|部署|测试|编写|设置|检查|优化|支持|解决|完善|补充)/iu;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

// Reject lines that are clearly not user goals (pasted output, code, paths, tool dumps)
// or meta-prompt boilerplate (command templates like `/issues` that start with "For each issue:"
// followed by numbered "Read the issue in full..." steps).
const NON_GOAL_RE =
  /^\s*[[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;

// Signals that the rest of the user message is a command template (e.g. /issues),
// in which case we should stop collecting goals at the signal line.
const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

const truncateAtTemplate = (lines: string[]): string[] => {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;

const isSubstantiveGoal = (text: string): boolean => {
  const t = text.trim();
  if (t.length < (/\p{Script=Han}/u.test(t) ? 4 : 6)) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
};

const FIRST_MSG_CLIP = 200;

const indexSuffix = (sourceIndex?: number): string =>
  sourceIndex != null ? ` (#${sourceIndex})` : "";

// Test scope-change / task intent only on the leading portion of a user block
// so that pasted outputs below the actual instruction do not trigger matches.
const LEADING_CHARS = 200;

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;
  let latestScopeIndex: number | undefined;

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = collapseSkillLines(truncated.filter(isSubstantiveGoal))
      .map(stripLeadingBullet)
      .filter(isSubstantiveGoal);
    if (lines.length === 0) continue;

    if (goals.length === 0) {
      goals.push(
        ...lines.slice(0, 6).map((l) => clip(l, FIRST_MSG_CLIP) + indexSuffix(b.sourceIndex)),
      );
      continue;
    }

    const leading = b.text.slice(0, LEADING_CHARS);
    if (/\p{Script=Han}/u.test(leading)) {
      if (/[?？]|^(?:是否|如果|假如|不要改|不需要改|不用改)|(?:吗|呢)[。！!]?$/u.test(leading.trim())) continue;
      // A status report mentioning 修复/测试 is not a new instruction.
      if (/^(?:修复|实现|添加|创建|重构|调试|调查|更新|删除|迁移|部署|测试|编写|设置|检查|优化|解决|完善|补充)(?:工作|任务)?(?:已经|已)?(?:完成|成功|结束|通过)/u.test(leading.trim())) continue;
      if (/^(?:请)?(?:不要|不用|不需要)(?:改|修复|添加|删除|部署|测试)/u.test(leading.trim())) continue;
      if (!/^(?:请|帮我|麻烦|改一下|改成|改为|换成|转而|接下来|现在(?:我)?(?:想|要|希望|需要)|新的?(?:任务|目标)|不再|修复|实现|添加|创建|重构|调试|调查|更新|删除|迁移|部署|测试|编写|设置|检查|优化|解决|完善|补充)/u.test(leading.trim())) continue;
    }
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
      latestScopeIndex = b.sourceIndex;
    } else if (TASK_RE.test(leading) && (/\p{Script=Han}/u.test(leading) || lines[0].length > 15)) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
      latestScopeIndex = b.sourceIndex;
    }
  }

  // Only emit the [Scope change] marker when we actually captured bullets.
  if (latestScopeChange && latestScopeChange.length > 0) {
    goals.push("[Scope change]" + indexSuffix(latestScopeIndex));
    for (const line of latestScopeChange) {
      goals.push(line + indexSuffix(latestScopeIndex));
    }
  }

  return goals.slice(0, 8);
};
