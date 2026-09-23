import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSections } from '../src/core/build-sections';
import { clipSentence } from '../src/core/content';
import { capRecallBlocks } from '../src/core/recall-budget';
import { clusterObservations, normalizeContent, sorensenDiceTokenSimilarity, tokenizeContent } from '../src/project-recall/dedup';
import { estimateStringTokens } from '../src/om/tokens';
const observation = (content: string, i: number) => ({id: String(i), content, timestamp: null, relevance: 'high' as const, sourceEntryIds: [], tokenCount: 10, sessionId: 'review', source: 'branch' as const});
test('unrelated Chinese facts survive, identical duplicates merge', () => {
  const a = '用户要求使用中文回复', b = '数据库迁移已经完成';
  assert.ok(normalizeContent(a));
  assert.equal(clusterObservations([a,b].map(observation), {fuzzy:true,sorensen:true}).length, 2);
  const identical = clusterObservations([a,a].map(observation), {fuzzy:true,sorensen:true});
  assert.equal(identical.length, 1);
  assert.equal(identical[0].occurrences, 2);
});
test('CJK segmentation supports ranking', () => {
  assert.ok(tokenizeContent('用户选择使用中文回复').length);
  assert.equal(sorensenDiceTokenSimilarity('用户选择使用中文回复','用户选择使用中文回复'), 1);
});
test('Chinese scope changes, preferences and blockers survive', () => {
  const sections = buildSections({blocks:[
    {kind:'user',text:'请检查登录模块的中文错误，并修复它。'},
    {kind:'user',text:'改一下，现在我希望修复注册模块，并且永远使用中文回复。'},
    {kind:'user',text:'登录模块仍然报错，无法完成登录。'},
  ]});
  assert.match(sections.sessionGoal.join('\n'), /注册模块/);
  assert.match(sections.userPreferences.join('\n'), /永远使用中文回复/);
  assert.match(sections.outstandingContext.join('\n'), /登录模块仍然报错/);
});
test('CJK sentence boundaries need no spaces; surrogate pairs stay intact', () => {
  assert.equal(clipSentence('登录模块失败。请继续检查注册模块并修复问题。',12), '登录模块失败。');
  assert.ok(!/[\uD800-\uDBFF]$/.test(clipSentence('abc😀defghijkl',4)));
});
test('Chinese fallback and explicit token budget', () => {
  const text = '这是一个用于测试中文压缩的句子。';
  assert.ok(estimateStringTokens(text) > Math.ceil(text.length/4));
  const capped = capRecallBlocks({header:'结果', entryBlocks:['中文记录'.repeat(50)],budget:1000,tokenBudget:100});
  assert.equal(capped.capped,true);
  assert.ok(estimateStringTokens(capped.text) <= 100);
});
