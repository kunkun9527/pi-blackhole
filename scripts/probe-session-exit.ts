// Offline lifecycle probe: no provider requests, no user sessions/configuration.
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const dir = mkdtempSync(join(tmpdir(), 'blackhole-exit-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.argv[1] = realpathSync(fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)));
let session: AgentSession | undefined;
const baseUrl = process.env.PROBE_BASE_URL;
if (baseUrl) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname), 'Offline probe only permits loopback');
const transport = baseUrl ? await (await import('C:/Users/Su/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/codex-stream.ts')).loadCliproxyCodexStreams() : undefined;
try {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 } });
  const compact = process.env.PROBE_COMPACT === '1';
  let compactions = 0;
  const memory = process.env.PROBE_MEMORY === '1';
  let workerRequests = 0;
  let workerResult: Promise<import('@earendil-works/pi-ai').AssistantMessage> | undefined;
  let sessionResult: Promise<import('@earendil-works/pi-ai').AssistantMessage> | undefined;
  if (memory) assert.ok(compact && process.env.PROBE_BLACKHOLE === '1', 'Memory probe requires Blackhole and compaction');
  if (compact) {
    mkdirSync(join(dir, 'pi-blackhole'), { recursive: true });
    writeFileSync(join(dir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ memory, observeAfterTokens: 3000, observerChunkMaxTokens: 30000, agentMaxTurns: 1, compaction: 'auto', midRunCompaction: 'resume', compactAfterTokens: 4000, statusBar: false, debugLog: process.env.PROBE_DEBUG === '1' }));
  }
  const factories: ExtensionFactory[] = process.env.PROBE_BLACKHOLE === '1' ? [(await import('../index.js')).default] : [];
  factories.push(pi => { pi.on('session_compact', () => { compactions++; }); });
  if (memory) factories.push(pi => {
    pi.registerProvider('anthropic', {
      api: 'anthropic-messages', apiKey: 'offline-only',
      models: [{ id: 'offline', name: 'Offline', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
      streamSimple: (requestedModel, context, options) => {
        workerRequests++;
        console.log('PROBE: worker transport selected=' + Boolean(transport && baseUrl));
        if (transport && baseUrl) {
          const stream = transport.streamSimple({ ...requestedModel, baseUrl }, context, { ...options, transport: 'sse' });
          workerResult = stream.result();
          return stream;
        }
        const stream = createAssistantMessageEventStream();
        const message: import('@earendil-works/pi-ai').AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'No new durable records.' }], api: requestedModel.api, provider: requestedModel.provider, model: requestedModel.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
        return stream;
      },
    });
  });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories });
  await loader.reload();
  console.log('PROBE: loader ready');
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  console.log('PROBE: runtime ready');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const model: import('@earendil-works/pi-ai').Model<'anthropic-messages'> = { id: 'offline', name: 'Offline', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://invalid.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 };
  await runtime.setRuntimeApiKey('anthropic', 'offline-only');
  const manager = SessionManager.inMemory(dir);
  if (compact) {
    for (let i = 0; i < 17; i++) manager.appendMessage({ role: 'user', content: `Synthetic history ${i}: ` + 'completed temporary check; '.repeat(64), timestamp: Date.now() });
  }
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: [] }));
  session.agent.streamFunction = (requestedModel, context, options) => {
    console.log('PROBE: session stream invoked');
    if (transport && baseUrl) {
      const stream = transport.streamSimple({ ...requestedModel, baseUrl }, context, { ...options, apiKey: 'offline-only', transport: 'sse' });
      sessionResult = stream.result();
      return stream;
    }
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'offline response' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop' as const, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (compact && compactions === 0) { message.usage.input = 6000; message.usage.totalTokens = 6001; }
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  };
  await session.bindExtensions({ onError: error => { throw new Error(`${error.event}: ${error.error}`); } });
  console.log('PROBE: session ready');
  session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
      console.error('PROBE: session provider error: ' + event.message.errorMessage);
    }
  });
  await session.prompt('offline ping');
  console.log('PROBE: prompt complete');
  if (transport) {
    assert.ok(sessionResult, 'Session transport never started');
    const result = await sessionResult;
    assert.equal(result.stopReason, 'stop', result.errorMessage);
  }
  if (compact) { assert.equal(compactions, 1); console.log('PROBE: automatic compaction complete'); }
  if (memory) {
    const deadline = Date.now() + 5000;
    while (workerRequests === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (memory) { assert.ok(workerRequests > 0, 'Memory worker never called the offline provider'); console.log(`PROBE: memory worker requests=${workerRequests}`); }
  if (transport && memory) {
    assert.ok(workerResult, 'Worker transport never started');
    const result = await workerResult;
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    console.log('PROBE: worker transport completed');
  }
  if (transport && compact) {
    const previousResult = sessionResult;
    await session.prompt('offline continuation after compaction');
    assert.ok(sessionResult, 'Continuation transport never started');
    assert.notEqual(sessionResult, previousResult, 'Continuation reused the previous result');
    const result = await sessionResult;
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    console.log('PROBE: post-compaction continuation complete');
  }
} finally {
  if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session?.dispose();
  transport?.closeOpenAICodexWebSocketSessions();
  if (process.env.PROBE_DEBUG === '1') {
    const { flushDebugLog } = await import('../src/om/debug-log.js');
    const { readFileSync, existsSync } = await import('node:fs');
    flushDebugLog();
    const log = join(dir, 'pi-blackhole/debug.ndjson');
    if (existsSync(log)) console.log(readFileSync(log, 'utf8'));
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('PROBE: cleanup complete');
}
