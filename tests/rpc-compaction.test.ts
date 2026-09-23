import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerBeforeCompactHook,
  UI_COMPACTION_SUMMARY,
  readStoredFullSummary,
} from '../src/hooks/before-compact.js';
import { registerCompactionContextHook } from '../src/hooks/compaction-context.js';
import { DEFAULTS } from '../src/core/unified-config.js';

function createMockPi() {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  return {
    handlers,
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers[event] = handler;
    },
  };
}

function createMockRuntime() {
  return {
    config: {
      ...DEFAULTS,
      compaction: 'auto',
      compactionEngine: 'blackhole',
      memory: false,
      debug: false,
      debugLog: false,
    },
    ensureConfig: () => {},
    compactWasPiVcc: false,
    lastCompactCancelled: false,
  } as any;
}

test('RPC mode session_before_compact saves UI notice to summary and full summary to details', async () => {
  const pi = createMockPi();
  const runtime = createMockRuntime();
  registerBeforeCompactHook(pi as any, runtime);

  const branchEntries = [
    { type: 'session', id: 's1', timestamp: '2026-09-18T00:00:00Z' },
    {
      type: 'message',
      id: 'm1',
      parentId: 's1',
      timestamp: '2026-09-18T00:01:00Z',
      message: { role: 'user', content: '重构认证服务并迁移数据库' },
    },
    {
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      timestamp: '2026-09-18T00:02:00Z',
      message: { role: 'assistant', content: '已完成数据库迁移脚本编写' },
    },
    {
      type: 'message',
      id: 'm3',
      parentId: 'm2',
      timestamp: '2026-09-18T00:03:00Z',
      message: { role: 'user', content: '继续执行单元测试' },
    },
  ];

  const preparation = {
    tokensBefore: 4000,
    firstKeptEntryId: 'm3',
    previousSummary: undefined,
    fileOps: { read: [], written: [], edited: [] },
  };

  const ctx = {
    mode: 'rpc',
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branchEntries,
      getEntries: () => branchEntries,
      getSessionId: () => 'sess-rpc-1',
    },
    ui: { notify: () => {} },
  };

  const beforeCompactHandler = pi.handlers['session_before_compact'];
  assert.ok(beforeCompactHandler, 'session_before_compact handler should be registered');

  const result = await beforeCompactHandler(
    {
      preparation,
      branchEntries,
      customInstructions: undefined,
    },
    ctx,
  );

  assert.ok(result?.compaction, 'compaction result should be returned');
  assert.equal(result.compaction.summary, UI_COMPACTION_SUMMARY);
  assert.ok(result.compaction.details?.blackholeFullSummary, 'blackholeFullSummary must exist in details');
  assert.ok(
    result.compaction.details.blackholeFullSummary.includes('重构认证服务') ||
      result.compaction.details.blackholeFullSummary.includes('[Session Goal]'),
    'Full summary must contain the conversation goal',
  );
});

test('TUI mode (non-RPC) keeps full summary in compaction.summary without blackholeFullSummary in details', async () => {
  const pi = createMockPi();
  const runtime = createMockRuntime();
  registerBeforeCompactHook(pi as any, runtime);

  const branchEntries = [
    { type: 'session', id: 's1', timestamp: '2026-09-18T00:00:00Z' },
    {
      type: 'message',
      id: 'm1',
      parentId: 's1',
      timestamp: '2026-09-18T00:01:00Z',
      message: { role: 'user', content: '优化编译器词法解析性能' },
    },
    {
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      timestamp: '2026-09-18T00:02:00Z',
      message: { role: 'assistant', content: '已优化 Tokenizer 正则匹配' },
    },
    {
      type: 'message',
      id: 'm3',
      parentId: 'm2',
      timestamp: '2026-09-18T00:03:00Z',
      message: { role: 'user', content: '好的，请检查基准测试' },
    },
  ];

  const preparation = {
    tokensBefore: 4000,
    firstKeptEntryId: 'm3',
    previousSummary: undefined,
    fileOps: { read: [], written: [], edited: [] },
  };

  const ctx = {
    mode: 'interactive', // Terminal / TUI mode
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branchEntries,
      getEntries: () => branchEntries,
      getSessionId: () => 'sess-tui-1',
    },
    ui: { notify: () => {} },
  };

  const beforeCompactHandler = pi.handlers['session_before_compact'];
  const result = await beforeCompactHandler(
    {
      preparation,
      branchEntries,
      customInstructions: undefined,
    },
    ctx,
  );

  assert.ok(result?.compaction);
  assert.notEqual(result.compaction.summary, UI_COMPACTION_SUMMARY);
  assert.ok(
    result.compaction.summary.includes('优化') || result.compaction.summary.includes('[Session Goal]'),
    'compaction.summary in TUI mode must be the real full summary',
  );
  assert.equal(result.compaction.details?.blackholeFullSummary, undefined);
});

test('context hook restores blackholeFullSummary into compactionSummary message for LLM', () => {
  const pi = createMockPi();
  const runtime = createMockRuntime();
  registerCompactionContextHook(pi as any, runtime);

  const fullSummaryContent = '[Session Goal]\n- 重构认证服务并迁移数据库\n\n[Files And Changes]\n- 无';
  const branchEntries = [
    { type: 'session', id: 's1', timestamp: '2026-09-18T00:00:00Z' },
    {
      type: 'compaction',
      id: 'c1',
      parentId: 's1',
      timestamp: '2026-09-18T00:05:00Z',
      summary: UI_COMPACTION_SUMMARY,
      firstKeptEntryId: 'm3',
      tokensBefore: 5000,
      details: {
        compactor: 'blackhole',
        version: 1,
        sections: ['Session Goal'],
        sourceMessageCount: 2,
        previousSummaryUsed: false,
        blackholeFullSummary: fullSummaryContent,
      },
    },
    {
      type: 'message',
      id: 'm3',
      parentId: 'c1',
      timestamp: '2026-09-18T00:06:00Z',
      message: { role: 'user', content: '现在的数据库结构如何？' },
    },
  ];

  const ctx = {
    sessionManager: {
      getBranch: () => branchEntries,
      getSessionId: () => 'sess-rpc-1',
    },
  };

  const initialMessages = [
    {
      role: 'compactionSummary',
      summary: UI_COMPACTION_SUMMARY,
      tokensBefore: 5000,
    },
    {
      role: 'user',
      content: '现在的数据库结构如何？',
    },
  ];

  const contextHandler = pi.handlers['context'];
  assert.ok(contextHandler, 'context hook handler should be registered');

  const result = contextHandler({ messages: initialMessages }, ctx);
  assert.ok(result?.messages, 'context hook should return transformed messages');
  assert.equal(result.messages[0].role, 'compactionSummary');
  assert.equal(result.messages[0].summary, fullSummaryContent, 'compactionSummary must be restored to full summary');
  assert.equal(result.messages[1].content, '现在的数据库结构如何？');
});

test('sequential RPC compactions carry forward previous summary from details.blackholeFullSummary', async () => {
  const pi = createMockPi();
  const runtime = createMockRuntime();
  registerBeforeCompactHook(pi as any, runtime);

  const firstFullSummary = '[Session Goal]\n- 阶段一：建立认证基础架构';
  const branchEntries = [
    { type: 'session', id: 's1', timestamp: '2026-09-18T00:00:00Z' },
    {
      type: 'compaction',
      id: 'c1',
      parentId: 's1',
      timestamp: '2026-09-18T00:05:00Z',
      summary: UI_COMPACTION_SUMMARY,
      firstKeptEntryId: 'm2',
      tokensBefore: 3000,
      details: {
        compactor: 'blackhole',
        version: 1,
        sections: ['Session Goal'],
        sourceMessageCount: 2,
        previousSummaryUsed: false,
        blackholeFullSummary: firstFullSummary,
      },
    },
    {
      type: 'message',
      id: 'm2',
      parentId: 'c1',
      timestamp: '2026-09-18T00:06:00Z',
      message: { role: 'user', content: '阶段二：新增 OAuth 授权流程' },
    },
    {
      type: 'message',
      id: 'm3',
      parentId: 'm2',
      timestamp: '2026-09-18T00:07:00Z',
      message: { role: 'assistant', content: 'OAuth 授权路由已新增完毕' },
    },
    {
      type: 'message',
      id: 'm4',
      parentId: 'm3',
      timestamp: '2026-09-18T00:08:00Z',
      message: { role: 'user', content: '准备开始阶段三' },
    },
  ];

  const preparation = {
    tokensBefore: 6000,
    firstKeptEntryId: 'm4',
    // Pi 核心传入的 previousSummary 可能会是 session 里保存的短 UI 文本
    previousSummary: UI_COMPACTION_SUMMARY,
    fileOps: { read: [], written: [], edited: [] },
  };

  const ctx = {
    mode: 'rpc',
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branchEntries,
      getEntries: () => branchEntries,
      getSessionId: () => 'sess-rpc-seq',
    },
    ui: { notify: () => {} },
  };

  const beforeCompactHandler = pi.handlers['session_before_compact'];
  const result = await beforeCompactHandler(
    {
      preparation,
      branchEntries,
      customInstructions: undefined,
    },
    ctx,
  );

  assert.ok(result?.compaction);
  assert.equal(result.compaction.summary, UI_COMPACTION_SUMMARY);
  const secondFullSummary = result.compaction.details.blackholeFullSummary;
  assert.ok(secondFullSummary, 'second compaction must have blackholeFullSummary');
  // 验证它成功继承了阶段一的内容，而不是把 UI_COMPACTION_SUMMARY 字符串当作上文
  assert.ok(
    secondFullSummary.includes('阶段一') || secondFullSummary.includes('认证'),
    'Second full summary must carry forward context from the first full summary',
  );
  assert.ok(
    !secondFullSummary.includes(UI_COMPACTION_SUMMARY),
    'Second full summary must not contain the UI notice as previous summary content',
  );
});
