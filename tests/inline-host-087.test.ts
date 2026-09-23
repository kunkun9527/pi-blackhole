import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { installInlineCompactionAdapter, compactInlineAtTurnBoundary } from '../src/om/inline-compaction.js';

// Real installed host compact(), preparation, projection and extension binding;
// only auth, event transport and model-generated summary are isolated (no network).
function fixture(cancel = false) {
  class HostSession extends AgentSession {}
  // Upstream deliberately inspects own prototype helpers only. Copy the real
  // host descriptors to isolate adapter installations without changing methods.
  Object.defineProperties(HostSession.prototype, Object.getOwnPropertyDescriptors(AgentSession.prototype));
  const status = installInlineCompactionAdapter({ sessionClass: HostSession as any });
  assert.equal(status.supported, true, status.reason);
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 8; i++) manager.appendMessage({ role: 'user', content: `message ${i} ` + 'history '.repeat(80), timestamp: i });
  const events: any[] = [];
  const session: any = Object.create(HostSession.prototype);
  let aborts = 0;
  session.agent = { state: { messages: manager.buildSessionContext().messages, model: { id: 'test', provider: 'test' } }, prepareNextTurnWithContext: async () => ({ context: { messages: ['stale'], marker: true }, messages: ['queued'] }) };
  session.sessionManager = manager;
  session.settingsManager = { getCompactionSettings: () => ({ enabled: true, reserveTokens: 10, keepRecentTokens: 80 }) };
  session._entryIdsByMessage = new WeakMap();
  session.abort = async () => { aborts++; };
  session._emit = (event: any) => events.push(event);
  session._resolveIdleWaitIfIdle = () => {};
  session._emitSessionCompactFailed = async () => {};
  session._getSummarizationRequestAuth = async () => ({ model: session.agent.state.model, apiKey: 'test-only' });
  session._extensionRunner = {
    bindCore() {},
    hasHandlers: () => true,
    emit: async (event: any) => {
      events.push(event);
      if (event.type === 'session_before_compact') return cancel ? { cancel: true } : { compaction: { summary: 'retained summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    },
  };
  session._bindExtensionCore(session._extensionRunner);
  return { session, manager, events, aborts: () => aborts };
}

test('installed host supports inline compaction and refreshes the next turn without abort', async () => {
  const { session, manager, events, aborts } = fixture();
  const originalAbort = session.abort;
  const oldMessages = session.agent.state.messages;
  const result = await compactInlineAtTurnBoundary(manager);
  assert.equal(result.summary, 'retained summary');
  assert.equal(aborts(), 0);
  assert.equal(session.abort, originalAbort);
  assert.equal(session._compactionAbortController, undefined);
  assert.notEqual(session.agent.state.messages, oldMessages);
  assert.deepEqual(session.agent.state.messages, manager.buildSessionContext().messages);
  assert.ok(manager.getEntries().some((entry: any) => entry.type === 'compaction'));
  assert.ok(events.some(event => event.type === 'session_compact'));
  const next = await session.agent.prepareNextTurnWithContext({ context: { messages: oldMessages } }, new AbortController().signal);
  assert.deepEqual(next.context.messages, session.agent.state.messages);
  assert.equal(next.context.marker, true);
  assert.deepEqual(next.messages, ['queued']);
  await session.abort();
  assert.equal(aborts(), 1);
});

test('host cancellation restores abort and permits another inline attempt', async () => {
  const { session, manager, aborts } = fixture(true);
  const originalAbort = session.abort;
  for (let i = 0; i < 2; i++) await assert.rejects(compactInlineAtTurnBoundary(manager), /Compaction cancelled/);
  assert.equal(session.abort, originalAbort);
  assert.equal(session._compactionAbortController, undefined);
  assert.equal(aborts(), 0);
  assert.equal(manager.getEntries().some((entry: any) => entry.type === 'compaction'), false);
});

test('unpaired tool call prevents native compaction', async () => {
  const { session, manager, events } = fixture();
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'test', arguments: {} }], stopReason: 'toolUse' } as any);
  await assert.rejects(compactInlineAtTurnBoundary(manager), /tool call is still in flight/);
  assert.equal(events.length, 0);
  assert.equal(session._compactionAbortController, undefined);
});

test('unknown context refresh shape remains rejected', () => {
  class UnknownHost {
    async abort() {}
    _bindExtensionCore() {}
    async compact() { await this.abort(); const appendCompaction = true; return appendCompaction as any; }
  }
  assert.equal(installInlineCompactionAdapter({ sessionClass: UnknownHost }).supported, false);
});

test('projection helper without a state refresh remains rejected', () => {
  class BrokenRefreshHost {
    async abort() {}
    _bindExtensionCore() {}
    _refreshFinalizedContext() {}
    async compact() {
      await this.abort();
      const appendCompaction = true;
      this._refreshFinalizedContext();
      return appendCompaction as any;
    }
  }
  assert.equal(installInlineCompactionAdapter({ sessionClass: BrokenRefreshHost }).supported, false);
});

test('legacy direct state refresh remains supported', () => {
  class LegacyHost {
    agent = { state: { messages: [] as unknown[] } };
    async abort() {}
    _bindExtensionCore() {}
    async compact() {
      await this.abort();
      const appendCompaction = true;
      this.agent.state.messages = [];
      return appendCompaction as any;
    }
  }
  assert.equal(installInlineCompactionAdapter({ sessionClass: LegacyHost }).supported, true);
});
