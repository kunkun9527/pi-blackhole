// Opt-in real SDK session: synthetic history, real provider and real Blackhole hooks.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession, ExtensionFactory } from '@earendil-works/pi-coding-agent';

const offlineUrl = process.env.BLACKHOLE_OFFLINE_URL;
if (offlineUrl) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(offlineUrl).hostname), 'Offline test only permits loopback');
if (!offlineUrl && process.env.BLACKHOLE_LIVE_TEST !== '1') throw new Error('Set BLACKHOLE_LIVE_TEST=1 to authorize provider calls');
const originalAgentDir = join(homedir(), '.pi/agent');
const connection = offlineUrl ? { apiKey: 'offline-only' } : JSON.parse(readFileSync(join(originalAgentDir, 'cliproxyapi.json'), 'utf8'));
const catalog = offlineUrl ? { inferenceBaseUrl: offlineUrl, models: [{ id: 'gemini-3.8-flash-high', name: 'Offline fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }] } : JSON.parse(readFileSync(join(originalAgentDir, 'cliproxyapi-models.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'blackhole-live-session-'));
process.env.PI_CODING_AGENT_DIR = dir;
// SDK does not have a CLI argv; give host discovery the actual installed launcher.
process.argv[1] = realpathSync(fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)));
const { loadCliproxyCodexStreams, CLIPROXYAPI_CODEX_API } = process.env.PROBE_PATCHED_PROVIDER === '1'
  ? await import('R:/pi-cliproxyapi-fix/extensions/codex-stream.ts')
  : await import('C:/Users/Su/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/codex-stream.ts');
const streams = await loadCliproxyCodexStreams();
let session: AgentSession | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const { Type } = await import('typebox');
  const { default: blackhole } = await import('../index.ts');
  const definition = catalog.models.find((m: { id: string }) => m.id === 'gemini-3.8-flash-high');
  assert.ok(definition, 'Requested model missing');
  const model = { ...definition, api: CLIPROXYAPI_CODEX_API, provider: 'cliproxyapi', baseUrl: catalog.inferenceBaseUrl };
  mkdirSync(join(dir, 'pi-blackhole'), { recursive: true });
  writeFileSync(join(dir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({
    compaction: 'auto', midRunCompaction: 'resume', compactAfterTokens: 4000,
    observeAfterTokens: 3000, observerChunkMaxTokens: 30000, reflectAfterTokens: 25000,
    memory: true, debugLog: true, showPreCompactionMessage: false, statusBar: false,
    agentMaxTurns: 5,
  }));
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: 'user', content: '必须长期保留：项目代号青鹭，数据库端口15432，禁止删除生产数据库。', timestamp: Date.now() });
  for (let i = 0; i < 16; i++) {
    manager.appendMessage({ role: 'user', content: `已完成的历史检查${i}，以下是可压缩的临时日志：` + `check-${i} completed successfully; `.repeat(48), timestamp: Date.now() });
  }
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 }, retry: { enabled: false } });
  let requests = 0;
  let compactions = 0;
  let toolCalls = 0;
  let resumedRequests = 0;
  let toolResultSeenAfterCompaction = false;
  const errors: string[] = [];
  const provider: ExtensionFactory = pi => {
    pi.on('session_compact', () => { compactions++; console.log(JSON.stringify({ stage: 'session_compact', compactions, requests })); });
    pi.registerProvider('cliproxyapi', {
      api: CLIPROXYAPI_CODEX_API, baseUrl: catalog.inferenceBaseUrl, apiKey: connection.apiKey,
      models: [definition],
      streamSimple: (requestedModel, context, options) => {
        assert.ok(++requests <= 18, 'Live test request budget exceeded');
        if (compactions > 0 && options?.sessionId === manager.getSessionId()) {
          resumedRequests++;
          const text = JSON.stringify(context.messages);
          assert.ok(text.includes('15432'), 'Next provider request lost historical port');
          assert.ok(text.includes('青鹭'), 'Next provider request lost project name');
          toolResultSeenAfterCompaction ||= text.includes('TOOL_RESULT_73921');
        }
        if (process.env.PROBE_UNIQUE_CACHE === '1') {
          return streams.streamSimple(requestedModel, context, { ...options, sessionId: `${options?.sessionId}-request-${requests}` });
        }
        return streams.streamSimple(requestedModel, context, options);
      },
    });
    pi.registerTool({
      name: 'acceptance_ping', label: 'Acceptance ping', description: 'Return the synthetic acceptance marker; no filesystem or external side effects.',
      parameters: Type.Object({}),
      async execute() { toolCalls++; return { content: [{ type: 'text', text: 'TOOL_RESULT_73921' }], details: {} }; },
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [blackhole, provider],
    systemPrompt: '你是隔离验收助手。遵守用户的工具调用要求，简短使用简体中文回答。',
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], 'Extension loading failed');
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: ['acceptance_ping'], thinkingLevel: 'low' }));
  await session.bindExtensions({ onError: error => errors.push(`${error.event}: ${error.error}\n${error.stack ?? ''}`) });
  assert.deepEqual(errors, [], 'Extension startup errors');
  const activeSession = session;
  timer = setTimeout(() => { void activeSession.abort(); }, 180000);
  await session.prompt('请先调用一次 acceptance_ping；取得工具结果后，再回答此前项目代号、数据库端口、禁止操作，以及工具返回的完整标记。不要省略任何一项。');
  assert.equal(toolCalls, 1, 'Expected exactly one completed tool call');
  assert.ok(compactions > 0, 'Automatic inline compaction never ran');
  assert.ok(resumedRequests > 0, 'No provider request resumed after compaction');
  assert.ok(toolResultSeenAfterCompaction, 'Completed tool result missing from resumed context');
  assert.deepEqual(errors, [], 'Extension runtime errors');
  const last = [...session.agent.state.messages].reverse().find(message => message.role === 'assistant');
  assert.ok(last && last.role === 'assistant');
  assert.equal(last.stopReason, 'stop', 'Session failed or stopped at tool boundary');
  const answer = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  for (const fact of ['青鹭', '15432', '73921', '删除']) assert.ok(answer.includes(fact), `Final answer lost ${fact}`);
  const { flushDebugLog } = await import('../src/om/debug-log.js');
  flushDebugLog();
  const debug = readFileSync(join(dir, 'pi-blackhole/debug.ndjson'), 'utf8');
  assert.ok(debug.includes('compaction_trigger.turn_end.inline_complete'), 'Did not exercise automatic turn_end inline path');
  assert.ok(!debug.includes('inline_adapter_unsupported'), 'Host adapter unsupported');
  assert.ok(!debug.includes('inline_failed'), 'Inline compaction failed');
  console.log(JSON.stringify({ stage: 'PASS', requests, compactions, resumedRequests, toolCalls, toolResultSeenAfterCompaction, syntheticHistoryEntries: 17 }));
  console.log('PASS: real AgentSession + Blackhole automatic inline compaction + real model continuation; historical data untouched.');
} finally {
  if (timer) clearTimeout(timer);
  if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  const { flushDebugLog } = await import('../src/om/debug-log.js');
  flushDebugLog();
  try {
    const records = readFileSync(join(dir, 'pi-blackhole/debug.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    console.log(JSON.stringify({ diagnostic: records.filter(record => String(record.event).startsWith('compaction_trigger.')) }));
  } catch { console.log('No compaction debug log was written'); }
  session?.dispose();
  streams.closeOpenAICodexWebSocketSessions();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: 'complete', activeResources: process.getActiveResourcesInfo?.() }));
}
