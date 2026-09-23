import type { NormalizedBlock } from '../types';
import { nonEmptyLines } from '../core/content';

const ENGLISH_PREFERENCE = /\b(?:prefer(?:s|red|ring)?\s+\w|don'?t want|always (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)|never (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)|please (?:use|avoid|keep|make|don'?t|do not|format|write)|(?:style|format|language|naming)\s*[:=]\s*\S)/i;
const CHINESE_PREFERENCE = /^(?:我(?:们)?|并且|而且|以后|今后|现在)?(?:请)?(?:始终|永远|一直|务必|默认|统一|改为|改用|不要|不能|别|禁止|避免|不想|不希望|不需要|希望|要求|需要|优先|使用|采用|保持|遵循|保留).*(?:使用|采用|保持|遵循|回复|回答|输出|格式|命名|语言|风格|修改|添加|删除|提交|部署|调用|原样)/u;
const QUESTION = /[?？]|^(?:是否|要不要|能否|可否|为什么|怎么|如何)|(?:吗|么|呢)[。！!]?$/u;
// Upstream correction anchors, restricted to directive starts to avoid chatter.
const CORRECTION = /^(?:(?:please\s+)?(?:stop\s+(?:doing|using)|revert\b|undo\b)|(?:that(?:'s| is)|this is)\s+wrong\b)|^(?:先|以后|今后|现在|请)?(?:不要|不用|别再|回退|停止)|^(?:以后|下次|必须)|^记住(?!了|吧|哦)/iu;
const isQuestion = (text: string) => QUESTION.test(text) && !/^(?:can|could|would) you (?:please )?(?:always|never)\b/i.test(text);
const CONDITIONAL = /如果|假如|假设|只有|仅在|除非|当.+时|的话|否则|\b(?:if|unless|only when)\b/iu;

/** Only a whole, standalone language directive can replace another language directive. */
function preferenceSlot(text: string): string | undefined {
  const t = text.replace(/[。.!！]+$/u, '').trim();
  if (/^(?:(?:我(?:们)?(?:希望|要求)|并且|以后|今后|现在)?(?:请)?(?:始终|永远|一直|务必|默认|统一|优先)?(?:使用|用|改为(?:使用|采用)?|改用|采用)?(?:中文|英文|英语|汉语)(?:进行)?(?:回复|回答|输出))$/u.test(t)) return 'response-language';
  if (/^(?:(?:please|always)\s+)?(?:reply|respond|answer)\s+(?:in\s+)?(?:Chinese|English)$/i.test(t)) return 'response-language';
  return undefined;
}

function clausesOf(line: string): Array<{text:string; inherited:boolean}> {
  // Preserve conditional/quoted scope as a whole; splitting can reverse its meaning.
  if (CONDITIONAL.test(line) || /[“”「」『』"]/.test(line)) return [{text:line,inherited:false}];
  if (CORRECTION.test(line) && !preferenceSlot(line.split(/[，。；;！]/u)[0].trim())) return [{text:line,inherited:false}];
  const clauses = /\p{Script=Han}/u.test(line) ? line.split(/[，。；;！]/u) : [line];
  return clauses.flatMap(clause => {
    const pair = clause.match(/^(.*?)(?:并且|并|而且)((?:保留|保持|遵循|不要|禁止).+)$/u);
    // The remainder is already part of an asserted compound directive. Do not drop it
    // merely because it fails the standalone preference recognizer.
    return pair && preferenceSlot(pair[1].trim())
      ? [{text:pair[1],inherited:false},{text:pair[2],inherited:true}]
      : [{text:clause,inherited:false}];
  });
}

export const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
  const prefs: string[] = [];
  for (const b of blocks) {
    if (b.kind !== 'user') continue;
    let fenced = false;
    for (const line of nonEmptyLines(b.text)) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced || isQuestion(line)) continue;
      for (const raw of clausesOf(line)) {
        const text = raw.text.trim();
        if (text.length < (raw.inherited ? 1 : /\p{Script=Han}/u.test(text) ? 2 : 4) || text.length > 200 || isQuestion(text)) continue;
        // Conditions remain attached to their directive, never occupy a global language slot.
        const conditionalPreference = CONDITIONAL.test(text) && text.split(/[，,；;]/u).some(s => CHINESE_PREFERENCE.test(s.trim()) || ENGLISH_PREFERENCE.test(s));
        if (!raw.inherited && !conditionalPreference && !CHINESE_PREFERENCE.test(text) && !ENGLISH_PREFERENCE.test(text) && !CORRECTION.test(text)) continue;
        const slot = preferenceSlot(text);
        for (let i = prefs.length - 1; i >= 0; i--) {
          if (prefs[i] === text || (slot && preferenceSlot(prefs[i]) === slot)) prefs.splice(i, 1);
        }
        prefs.push(text);
      }
    }
  }
  return prefs.slice(-10);
};

export const dedupPreferencesAgainstGoals = (prefs: string[], goals: string[]): string[] => {
  const goalSet = new Set(goals.map(s => s.trim()));
  return prefs.filter(p => !goalSet.has(p.trim()));
};
