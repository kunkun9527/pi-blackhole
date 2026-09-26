import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { runObserver } from '../src/om/agents/observer/agent.js';
import { InputBudgetError } from '../src/om/input-budget.js';

// Pi 0.87 runs the agent loop as `void runAgentLoop(...).then(...)` with no
// catch: a throw from the stream function becomes an unhandled rejection and
// kills the host process. These tests drive the real loop.

const model = (contextWindow: number): Model<'anthropic-messages'> => ({
  id: 'offline', name: 'Offline', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://invalid.invalid',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1000,
});
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Turn 1 records a large partial batch (complete=false); turn 2 closes the chunk. */
function twoTurnStream(): { streamFn: StreamFn; calls: () => number } {
  let calls = 0;
  const streamFn: StreamFn = (m) => {
    calls++;
    const complete = calls > 1;
    const observations = complete ? [] : [{ content: '用户偏好'.repeat(1500), relevance: 'high', sourceEntryIds: ['source'] }];
    const message: AssistantMessage = {
      role: 'assistant', api: m.api, provider: m.provider, model: m.id, usage, timestamp: Date.now(), stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: `call-${calls}`, name: 'record_observations', arguments: { observations, complete } }],
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'toolUse', message });
    stream.end(message);
    return stream;
  };
  return { streamFn, calls: () => calls };
}

async function withUnhandledRejections<T>(run: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await Promise.race([
      run().then(value => ({ status: 'fulfilled', value }) as const, reason => ({ status: 'rejected', reason }) as const),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runObserver hung')), 3000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 20));
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

const args = (contextWindow: number, streamFn: StreamFn) => ({
  model: model(contextWindow), apiKey: 'offline', streamFn,
  chunk: '[Source entry id: source] 用户要求使用中文', allowedSourceEntryIds: ['source'],
  priorReflections: [], priorObservations: [],
  inputMaxTokens: 6000, contextWindow,
});

test('later turns may exceed the configured input budget while they fit the model window', async () => {
  const { streamFn, calls } = twoTurnStream();
  const { result, unhandled } = await withUnhandledRejections(() => runObserver(args(200_000, streamFn)));
  assert.deepEqual(unhandled, []);
  assert.equal(result.status, 'fulfilled', String((result as any).reason));
  assert.equal(calls(), 2);
  assert.equal((result as any).value.observations.length, 1);
});

test('a turn over the model window fails the run cleanly instead of crashing the host', async () => {
  const { streamFn, calls } = twoTurnStream();
  // Window room = 12000 - 1000 output - 1024 margin = 9976; turn 1 fits, turn 2 does not.
  const { result, unhandled } = await withUnhandledRejections(() => runObserver(args(12_000, streamFn)));
  assert.deepEqual(unhandled, []);
  assert.equal(result.status, 'rejected');
  assert.ok((result as any).reason instanceof InputBudgetError, String((result as any).reason));
  assert.equal(calls(), 1, 'the over-budget request must never reach the provider');
});
