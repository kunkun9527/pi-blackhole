import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReflector } from '../src/om/agents/reflector/agent';
import { runObserver } from '../src/om/agents/observer/agent';
import { buildCompactionProjection, foldLedger, OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED } from '../src/om/ledger/index';
import { detectMemoryLanguage } from '../src/om/memory-language';
import { selectGoalLines } from '../src/extract/goals';
import { compile } from '../src/core/summarize';
import { buildSections } from '../src/core/build-sections';
import { hashId } from '../src/om/ids';

const model: any = { id: 'offline', provider: 'offline', api: 'openai-completions', contextWindow: 20000, maxTokens: 1000 };
const noNetwork = () => { throw new Error('network forbidden'); };
const user = (id: string, content: any) => ({ id, type: 'message', message: { role: 'user', content } }) as any;
const obs = (id: string, content = '部署完成') => ({ id, content, timestamp: '2026-10-05', relevance: 'high' as const, sourceEntryIds: ['s'], tokenCount: 1 });
const refl = (id: string, content: string, support: string[], replaces?: string[]) => ({ id, content, supportingObservationIds: support, ...(replaces ? { replacesReflectionIds: replaces } : {}), tokenCount: 1 });
function loop(onCall: (ctx: any, prompts: any[]) => Promise<void>, seen: any[] = []) {
  return ((prompts: any[], ctx: any) => {
    seen.push(ctx);
    const stream: any = (async function* () { await onCall(ctx, prompts); yield { type: 'agent_end', messages: [{ stopReason: 'stop' }] }; })();
    stream.result = async () => []; return stream;
  }) as any;
}

test('memory language follows the user messages, ignoring pasted skills and code', () => {
  assert.equal(detectMemoryLanguage([user('a', 'Please fix the failing build script'), user('b', [{ type: 'text', text: '帮我看看这个报错' }])]), 'zh-Hans');
  assert.equal(detectMemoryLanguage([user('a', 'Please fix the failing build script now')]), undefined);
  assert.equal(detectMemoryLanguage([user('a', 'Please fix this:\n```\n// 中文注释\n```\n<skill name="x">中文说明</skill>')]), undefined);
  const english = Array.from({ length: 3 }, (_, i) => user('e' + i, 'Run the whole test suite again please'));
  assert.equal(detectMemoryLanguage([user('z', '好的'), ...english]), undefined, 'majority of recent messages decides');
});

test('worker system prompts carry the language rule only for Chinese sessions', async () => {
  const seen: any[] = [];
  const common = { model, apiKey: 'offline', agentLoop: loop(async () => {}, seen), streamFn: noNetwork };
  await runObserver({ ...common, chunk: '[Source entry id: s] 你好', allowedSourceEntryIds: ['s'], priorReflections: [], priorObservations: [], memoryLanguage: 'zh-Hans' });
  await runReflector({ ...common, observations: [obs('000000000001')], reflections: [], memoryLanguage: 'zh-Hans' });
  await runReflector({ ...common, observations: [obs('000000000001')], reflections: [] });
  // The system prompt carrier differs across Pi versions; search the whole context.
  const text = seen.map((ctx) => JSON.stringify(ctx));
  assert.match(text[0], /Simplified Chinese/);
  assert.match(text[1], /Simplified Chinese/);
  assert.doesNotMatch(text[2], /Simplified Chinese/);
});

test('a replacement inherits support, and unknown replaced ids are ignored', async () => {
  const old = [refl('aaaaaaaaaaaa', 'Fork is not pushed', ['000000000001']), refl('bbbbbbbbbbbb', 'fork 尚未推送', ['000000000002'])];
  const agentLoop = loop(async (ctx) => {
    await ctx.tools[0].execute('r', { reflections: [
      { content: 'fork 已推送为 cc8bccf', supportingObservationIds: [], replacesReflectionIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'ffffffffffff'] },
      { content: '没有依据的反思', supportingObservationIds: [] },
    ], complete: true });
  });
  const { reflections } = await runReflector({ model, apiKey: 'offline', observations: [obs('000000000003')], reflections: [], replaceableReflections: old, agentLoop, streamFn: noNetwork });
  assert.equal(reflections?.length, 1);
  assert.deepEqual(reflections![0].replacesReflectionIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.deepEqual(new Set(reflections![0].supportingObservationIds), new Set(['000000000001', '000000000002']));
});

test('replaced reflections leave the fold and projection but stay in the ledger', () => {
  const marker = (id: string, customType: string, data: any) => ({ id, type: 'custom', customType, data }) as any;
  const entries: any[] = [
    user('s', '推送 fork'),
    marker('m1', OM_OBSERVATIONS_RECORDED, { observations: [obs('000000000001')], coversUpToId: 's' }),
    marker('m2', OM_REFLECTIONS_RECORDED, { reflections: [refl('aaaaaaaaaaaa', 'fork 尚未推送', ['000000000001'])], coversUpToId: 'm1' }),
    marker('m3', OM_REFLECTIONS_RECORDED, { reflections: [refl('cccccccccccc', 'fork 已推送', ['000000000001'], ['aaaaaaaaaaaa'])], coversUpToId: 'm2' }),
  ];
  assert.deepEqual(foldLedger(entries).reflections.map((r) => r.id), ['cccccccccccc']);
  assert.deepEqual(buildCompactionProjection(entries, '', { observationsPoolMaxTokens: 1000 }).reflections.map((r: any) => r.id), ['cccccccccccc']);
  assert.ok(JSON.stringify(entries).includes('fork 尚未推送'));
});

test('Session Goal keeps the first message and the newest goals, with only the latest scope change (D16)', () => {
  const lines = ['修复登录 (#1)', '补中文测试 (#1)', ...Array.from({ length: 10 }, (_, i) => [`[Scope change] (#${i + 2})`, `任务 ${i} (#${i + 2})`]).flat()];
  const goals = selectGoalLines(lines);
  assert.ok(goals.length <= 8);
  assert.deepEqual(goals.slice(0, 2), ['修复登录 (#1)', '补中文测试 (#1)']);
  assert.equal(goals.at(-1), '任务 9 (#11)');
  assert.equal(goals.filter((l) => l.startsWith("[Scope change]")).length, 1);
});

test('Files And Changes drops paths that no longer exist, including inherited ones (D17)', () => {
  const base = { messages: [{ role: 'user', content: '继续', timestamp: 1 }] as any, cwd: '/repo' };
  const prev = compile({ ...base, fileOps: { modifiedFiles: ['/repo/src/a.ts', '/tmp/edit1.py'] } });
  assert.match(prev, /edit1\.py/);
  const next = compile({ ...base, previousSummary: prev, pathExists: (p) => !p.includes('edit1') });
  assert.match(next, /src\/a\.ts/);
  assert.doesNotMatch(next, /edit1\.py/);
});

test('Outstanding Context lists unresolved tool errors with their reason (D18)', () => {
  const call = (command: string) => ({ kind: 'tool_call', name: 'bash', args: { command } }) as const;
  const result = (text: string, isError: boolean) => ({ kind: 'tool_result', name: 'bash', text, isError }) as const;
  const out = buildSections({ blocks: [
    call('bun test'), result('Traceback (most recent call last):\n  File "a.py"\nValueError: bad input', true),
    call('git push'), result('(no output)', true),
    call('git push'), result('done', false),
  ] as any }).outstandingContext;
  assert.deepEqual(out, ['[bash] `bun test` ValueError: bad input']);
});

test('restoring an earlier wording (A -> B -> A) leaves the restored reflection active (D15)', async () => {
  const a = refl(hashId('记忆已开启'), '记忆已开启', ['000000000001']);
  const b = refl('bbbbbbbbbbbb', '记忆已关闭', ['000000000001'], [a.id]);
  const agentLoop = loop(async (ctx) => {
    await ctx.tools[0].execute('r', { reflections: [{ content: '记忆已开启', supportingObservationIds: [], replacesReflectionIds: [b.id] }], complete: true });
  });
  const { reflections } = await runReflector({ model, apiKey: 'offline', observations: [obs('000000000002')], reflections: [], replaceableReflections: [b], agentLoop, streamFn: noNetwork });
  const restored = reflections![0];
  assert.notEqual(restored.id, a.id);
  const marker = (id: string, data: any) => ({ id, type: 'custom', customType: OM_REFLECTIONS_RECORDED, data }) as any;
  const entries = [marker('m1', { reflections: [a], coversUpToId: 's' }), marker('m2', { reflections: [b], coversUpToId: 'm1' }), marker('m3', { reflections: [restored], coversUpToId: 'm2' })];
  assert.deepEqual(foldLedger(entries).reflections.map((r) => r.content), ['记忆已开启']);
});
