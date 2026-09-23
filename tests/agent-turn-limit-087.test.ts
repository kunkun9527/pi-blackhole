import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { runObserver } from '../src/om/agents/observer/agent.js';
import { runReflector } from '../src/om/agents/reflector/agent.js';
import { runDropper } from '../src/om/agents/dropper/agent.js';
import { createTurnLimit } from '../src/om/turn-limit.js';

const model: Model<'anthropic-messages'> = { id: 'offline', name: 'Offline', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://invalid.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 };
const observation = { id: 'abcdef123456', content: '保留中文约束', timestamp: '2026-09-21', relevance: 'high' as const, sourceEntryIds: ['source'], tokenCount: 10 };

for (const stage of ['observer', 'reflector', 'dropper'] as const) {
  test(`${stage}: maxTurns ends a real tool loop and does not commit partial coverage`, async () => {
    let calls = 0;
    const streamFn: StreamFn = (_model, context) => {
      calls++;
      const tool = getCurrentTools(context.messages)[0];
      assert.ok(tool);
      // Finite fixture: old shouldStopAfterTurn incorrectly reaches the second request.
      const keepCalling = calls === 1;
      const args: Record<string, never[]> = stage === 'observer' ? { observations: [] } : stage === 'reflector' ? { reflections: [] } : { ids: [] };
      const message: AssistantMessage = { role: 'assistant', content: keepCalling ? [{ type: 'toolCall', id: 'call-1', name: tool.name, arguments: args }] : [{ type: 'text', text: 'done' }], stopReason: keepCalling ? 'toolUse' : 'stop', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: keepCalling ? 'toolUse' : 'stop', message });
      stream.end(message);
      return stream;
    };
    const common = { model, apiKey: 'offline-only', streamFn, maxTurns: 1 };
    const run = () => stage === 'observer'
      ? runObserver({ ...common, chunk: '[Source entry id: source] 使用中文', allowedSourceEntryIds: ['source'], priorReflections: [], priorObservations: [] })
      : stage === 'reflector'
        ? runReflector({ ...common, observations: [observation], reflections: [] })
        : runDropper({ ...common, observations: [observation], reflections: [], budgetTokens: 1 });
    await assert.rejects(run, /Incomplete agent response.*toolUse/);
    assert.equal(calls, 1);
  });
}

test('turn limits preserve hard exits and count only completed normal turns', async () => {
  for (const value of [undefined, 0, -1, NaN, Infinity]) assert.equal(createTurnLimit(value), undefined);
  const finish = createTurnLimit(2);
  assert.ok(finish);
  const message: AssistantMessage = { role: 'assistant', content: [], stopReason: 'error', api: model.api, provider: model.provider, model: model.id, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const turn = { message, context: { messages: [] }, newMessages: [], toolResults: [] };
  assert.equal(await finish(turn), undefined);
  message.stopReason = 'aborted';
  assert.equal(await finish(turn), undefined);
  message.stopReason = 'toolUse';
  assert.equal(await finish(turn), undefined);
  assert.deepEqual(await finish(turn), { action: 'end' });
});
