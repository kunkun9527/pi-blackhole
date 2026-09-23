// Explicit opt-in live test; never reads/writes historical sessions or memory.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
if (process.env.BLACKHOLE_LIVE_TEST !== '1') throw new Error('Set BLACKHOLE_LIVE_TEST=1 to authorize paid provider calls');
const userAgentDir = join(homedir(), '.pi/agent');
const connection = JSON.parse(readFileSync(join(userAgentDir, 'cliproxyapi.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(userAgentDir, 'cliproxyapi-models.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'blackhole-live-workers-'));
process.env.PI_CODING_AGENT_DIR = dir;
const { loadCliproxyCodexStreams, CLIPROXYAPI_CODEX_API } = await import('C:/Users/Su/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/codex-stream.ts');
const streams = await loadCliproxyCodexStreams();
try {
  const { runObserver } = await import('../src/om/agents/observer/agent.ts');
  const { runReflector } = await import('../src/om/agents/reflector/agent.ts');
  const { runDropper } = await import('../src/om/agents/dropper/agent.ts');
  const definition = catalog.models.find((m: { id: string }) => m.id === 'gemini-3.8-flash-high');
  assert.ok(definition, 'Requested model missing');
  const model = { ...definition, api: CLIPROXYAPI_CODEX_API, provider: 'cliproxyapi', baseUrl: catalog.inferenceBaseUrl };
  let requests = 0;
  const common = { model, apiKey: connection.apiKey, maxTurns: 5, thinkingLevel: 'low' as const, signal: AbortSignal.timeout(120000), streamFn: (...args: Parameters<typeof streams.streamSimple>) => { requests++; return streams.streamSimple(...args); } };
  const observed = await runObserver({ ...common, priorObservations: [], priorReflections: [], allowedSourceEntryIds: ['live-source-1'], chunk: '[Source entry id: live-source-1]\n用户：项目代号为青鹭，数据库端口固定为15432。请始终使用简体中文回答；禁止删除生产数据库。上述要求必须作为长期记忆保存。' });
  assert.ok(observed.observations?.length, 'Observer produced no durable memory');
  assert.ok(observed.observations.every(o => o.sourceEntryIds.includes('live-source-1')), 'Source attribution lost');
  assert.ok(observed.observations.some(o => o.content.includes('15432')), 'Exact numeric fact lost');
  console.log(JSON.stringify({ stage: 'observer', records: observed.observations.length, requests }));
  const reflections = await runReflector({ ...common, observations: observed.observations, reflections: [] });
  assert.ok(reflections?.length, 'Reflector produced no memory');
  console.log(JSON.stringify({ stage: 'reflector', records: reflections.length, requests }));
  const requestsBeforeDropper = requests;
  const candidates = [...observed.observations, { id: 'abcdef000001', content: '临时调试输出：一次性打印hello，调试已结束，无长期价值。', timestamp: '2026-09-22', relevance: 'low' as const, sourceEntryIds: ['live-source-debug'], tokenCount: 30 }];
  const dropped = await runDropper({ ...common, observations: candidates, reflections, budgetTokens: 1 });
  assert.ok(requests > requestsBeforeDropper, 'Dropper provider path was not exercised');
  const known = new Set(candidates.map(o => o.id));
  assert.ok((dropped ?? []).every(id => known.has(id)), 'Dropper invented unknown IDs');
  assert.ok(candidates.filter(o => o.relevance === 'critical').every(o => !(dropped ?? []).includes(o.id)), 'Critical fact was dropped');
  console.log(JSON.stringify({ stage: 'dropper', drops: dropped?.length ?? 0, requests }));
  console.log('PASS: real CLIProxyAPI worker pipeline; synthetic input only; history untouched. This is not a full AgentSession long-conversation test.');
} finally {
  streams.closeOpenAICodexWebSocketSessions();
  rmSync(dir, { recursive: true, force: true });
}
