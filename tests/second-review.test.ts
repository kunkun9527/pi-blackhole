import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPreferences } from '../src/extract/preferences';
import { extractGoals } from '../src/extract/goals';
import { buildSections } from '../src/core/build-sections';
import { buildExistingObservationsSummary, buildExistingReflectionsSummary } from '../src/om/ledger/progress';
import { estimateStringTokens } from '../src/om/tokens';
const users = (...texts: string[]) => texts.map(text => ({kind:'user' as const,text}));

test('conditional preferences never become unconditional directives', () => {
  for (const text of ['如果是在测试环境，默认使用英文回复。','仅在我明确要求时，默认使用英文回复。']) {
    const out=extractPreferences(users(text));
    assert.ok(!out.includes('默认使用英文回复'));
  }
});
test('language changes retain unrelated compound constraints', () => {
  for(const constraint of ['保留代码原样','保留注释','保持缩进','遵循规范','保留名']) {
    const out=extractPreferences(users(`始终使用中文回复并${constraint}。`,'改用英文回复。'));
    assert.ok(out.includes(constraint),constraint);
    assert.ok(out.some(s=>s.includes('英文回复')));
    assert.ok(!out.some(s=>s.includes('中文回复')));
  }
});
test('Chinese and English mixed status retains active failures', () => {
  for (const text of ['登录模块已经修复，但注册模块报错。','Login was fixed, but registration failed.']) {
    const out=buildSections({blocks:users(text)}).outstandingContext;
    assert.ok(out.some(s=>s.includes('注册模块报错')||s.includes('registration failed')));
  }
});
test('English blocker recognition is backwards compatible', () => {
  for (const text of ['The login module does not work.',"The login module doesn't work.","The login module won't work.",'The login result is still wrong.']) {
    assert.ok(buildSections({blocks:users(text)}).outstandingContext.length>0,text);
  }
});
test('short Chinese tasks update goals while completion reports do not', () => {
  assert.ok(extractGoals(users('请检查登录模块的实现。','请修复注册模块。')).some(s=>s.includes('注册模块')));
  assert.ok(!extractGoals(users('请检查登录模块的实现。','修复已经完成，所有登录模块的测试均已通过。')).includes('[Scope change]'));
});
test('existing summaries obey small and zero budgets even for oversized first records', () => {
  const obs={id:'012345abcdef',content:'中文'.repeat(1000),timestamp:'2026-09-16',relevance:'high' as const,sourceEntryIds:['s'],tokenCount:500};
  const ref={id:'abcdef012345',content:obs.content,supportingObservationIds:[obs.id],tokenCount:500};
  for (const cap of [0,1,100,4000]) {
    assert.ok(estimateStringTokens(buildExistingObservationsSummary([obs],cap))<=cap);
    assert.ok(estimateStringTokens(buildExistingReflectionsSummary([ref],cap))<=cap);
  }
});
