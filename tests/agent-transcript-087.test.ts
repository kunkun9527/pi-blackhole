import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { runObserver } from '../src/om/agents/observer/agent.js';
import { runReflector } from '../src/om/agents/reflector/agent.js';
import { runDropper } from '../src/om/agents/dropper/agent.js';
import { OBSERVER_SYSTEM } from '../src/om/agents/observer/prompts.js';
import { REFLECTOR_SYSTEM } from '../src/om/agents/reflector/prompts.js';
import { DROPPER_SYSTEM } from '../src/om/agents/dropper/prompts.js';
import { budgetedStream, InputBudgetError } from '../src/om/input-budget.js';

const model: Model<'anthropic-messages'> = { id: 'offline', name: 'Offline', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://invalid.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 };
const observation = { id: 'abcdef123456', content: '用户要求使用中文', timestamp: '2026-09-21', relevance: 'high' as const, sourceEntryIds: ['source'], tokenCount: 10 };

for (const stage of ['observer', 'reflector', 'dropper'] as const) {
  test(`${stage}: real Pi 0.87 loop sends system instructions and tool declarations to provider`, async () => {
    const expected = { observer: OBSERVER_SYSTEM, reflector: REFLECTOR_SYSTEM, dropper: DROPPER_SYSTEM }[stage];
    let seen = 0;
    const streamFn: StreamFn = (_model, context) => {
      seen++;
      const instructions = context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      assert.ok(instructions.includes(expected), `${stage} system prompt lost at provider boundary`);
      assert.ok(getCurrentTools(context.messages).length > 0, 'tool declaration missing');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'No new durable records.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
      return stream;
    };
    const common = { model, apiKey: 'offline-only', streamFn, maxTurns: 1 };
    if (stage === 'observer') await runObserver({ ...common, chunk: '[Source entry id: source] 用户要求使用中文', allowedSourceEntryIds: ['source'], priorReflections: [], priorObservations: [] });
    if (stage === 'reflector') await runReflector({ ...common, observations: [observation], reflections: [] });
    if (stage === 'dropper') await runDropper({ ...common, observations: [observation], reflections: [], budgetTokens: 1 });
    assert.equal(seen, 1);
  });
}

test('transcript budget includes tool schemas and named system sections', () => {
  let calls = 0;
  for (const extra of [
    { toolsAdded: [{ name: 'large', description: '中文'.repeat(2000), parameters: {} }] },
    { sections: { instructions: '中文'.repeat(2000) } },
  ]) {
    const guard = budgetedStream(() => { calls++; }, 1000);
    guard(model, { messages: [{ role: 'system', content: '', ...extra, timestamp: 0 }] }, {});
    assert.ok(guard.error instanceof InputBudgetError);
  }
  assert.equal(calls, 0);
});
