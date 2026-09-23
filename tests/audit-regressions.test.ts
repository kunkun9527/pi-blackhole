import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterObservations, clusterReflections, exactContentKey } from '../src/project-recall/dedup';
import { capRecallBlocks } from '../src/core/recall-budget';
import { extractPreferences } from '../src/extract/preferences';
import { buildSections } from '../src/core/build-sections';
import { estimateStringTokens, estimateEntryTokens } from '../src/om/tokens';

const observation = (content: string, i: number) => ({id: String(i), content, timestamp: null, relevance: 'high' as const, sourceEntryIds: [], tokenCount: 10, sessionId: 'audit', source: 'branch' as const});
const pairs = [
  ['使用 C#', '使用 C'], ['使用 C++', '使用 C#'],
  ['读取 a/b', '读取 a.b'], ['配置 Foo', '配置 foo'],
  ['不要删除用户数据，允许删除日志', '允许删除用户数据，不要删除日志'],
  ['生产服务器仅允许部署登录模块版本一', '生产服务器仅允许部署注册模块版本一'],
  ['x'.repeat(700) + 'allow', 'x'.repeat(700) + 'deny'],
  ['!!!', '???'], ['值为 ①', '值为 1'],
];
for (const [a, b] of pairs) test(`distinct facts survive: ${a.slice(0, 35)}`, () => {
  assert.notEqual(exactContentKey(a), exactContentKey(b));
  for (const options of [{}, { fuzzy: true }, { sorensen: true }, { fuzzy: true, sorensen: true }]) {
    assert.equal(clusterObservations([a,b].map(observation), options).length, 2);
    assert.equal(clusterReflections([a,b].map((content) => ({content, timestamp: null, sessionId: 'audit', supportingObservationIds: [], source: 'branch' as const})), options).length, 2);
  }
});
test('independent recall limits: char-only must not imply tokens', () => {
  const result = capRecallBlocks({header: '结果', entryBlocks: ['中'.repeat(20)], budget: 100, tokenBudget: 0});
  assert.equal(result.capped, false);
});
test('token-only recall limit works with unlimited chars', () => {
  const result = capRecallBlocks({header: '结果', entryBlocks: ['中'.repeat(500)], budget: 0, tokenBudget: 100});
  assert.equal(result.capped, true);
  assert.ok(estimateStringTokens(result.text) <= 100);
});
test('recall accounts for header, separators and continuation', () => {
  const result = capRecallBlocks({header: 'h', entryBlocks: ['x'.repeat(99)], budget: 100, tokenBudget: 0});
  assert.equal(result.capped, true);
  assert.ok(result.text.length <= 100);
});
test('Chinese negation must not become a positive preference', () => {
  const prefs = extractPreferences([{kind:'user', text:'我不希望使用英文回复，请使用中文回复。'}]);
  assert.ok(prefs.every(p => !p.startsWith('希望使用英文')));
  assert.ok(prefs.join('\n').includes('不希望使用英文'));
});
test('question is not an asserted preference', () => {
  assert.deepEqual(extractPreferences([{kind:'user', text:'是否应该始终使用英文回复'}]), []);
});
test('latest language preference supersedes previous explicit language', () => {
  const prefs = extractPreferences([{kind:'user',text:'请始终使用英文回复。'}, {kind:'user',text:'改为使用中文回复。'}]);
  assert.ok(prefs.join('\n').includes('中文'));
  assert.ok(!prefs.join('\n').includes('英文'));
});
test('short Chinese blocker retained, resolved statement not treated as blocker', () => {
  const sections = buildSections({blocks:[{kind:'user',text:'登录仍然报错。'}]});
  assert.ok(sections.outstandingContext.join('\n').includes('报错'));
  const resolved = buildSections({blocks:[{kind:'user',text:'登录模块的错误已经修复，现在运行正常。'}]});
  assert.deepEqual(resolved.outstandingContext, []);
});
test('Chinese tool arguments and thinking are not counted as ASCII', () => {
  for(const content of [[{type:'thinking',thinking:'中'.repeat(200)}], [{type:'toolCall',id:'a',name:'write',arguments:{content:'中'.repeat(200)}}]]) {
    assert.ok(estimateEntryTokens({type:'message',message:{role:'assistant',content}}) >= estimateStringTokens('中'.repeat(200)));
  }
});
