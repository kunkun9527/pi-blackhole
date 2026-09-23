import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterObservations, clusterReflections } from '../src/project-recall/dedup';
import { suppressCoveredByReflections, buildExportMarkdown } from '../src/project-recall/format-export';
import { __setTestConfigDir, loadUnifiedConfig } from '../src/core/unified-config';
import { registerRecallTool } from '../src/tools/recall';
import { capRecallBlocks, capRecallText } from '../src/core/recall-budget';
import { estimateStringTokens, estimateEntryTokens, getUsageTokens } from '../src/om/tokens';
import { buildSections } from '../src/core/build-sections';
import { formatSummary } from '../src/core/format';

const obs = (content: string, i: number) => ({id: String(i), content, timestamp: '2026-09-16T00:00:00Z', relevance: 'critical' as const, sourceEntryIds: [], tokenCount: 10, sessionId: 'test', source: 'branch' as const});
const refl = (content: string) => ({content,timestamp:'2026-09-16T00:00:00Z',sessionId:'test',supportingObservationIds:[],source:'branch' as const});

test('reflection coverage only suppresses identical facts', () => {
  const a = '不要删除用户数据，允许删除日志', b = '允许删除用户数据，不要删除日志';
  const observations = clusterObservations([a,b,'使用 C#','使用 C'].map(obs));
  const result = suppressCoveredByReflections(observations, clusterReflections([refl(a),refl('使用 C')]));
  assert.equal(result.suppressed,2);
  assert.deepEqual(new Set(result.kept.map(c => c.rep.content)),new Set([b,'使用 C#']));
});

test('project export retains distinct critical Chinese observations', () => {
  const texts = ['不要删除用户数据，允许删除日志','允许删除用户数据，不要删除日志','使用 C#','使用 C'];
  const result = buildExportMarkdown({projectRoot:'test',sessionsConsidered:1,filesWithMarkers:1,observations:texts.map(obs),reflections:[],droppedIds:new Set(),knownSessionIds:new Set(['test']),orphanedSessions:0});
  for(const text of texts) assert.ok(JSON.stringify(result).includes(text));
});

test('token config loads independently, allows zero and supports env override', () => {
  const dir = mkdtempSync(join(tmpdir(),'bh-config-'));
  const old = process.env.PI_BLACKHOLE_RECALL_RESPONSE_MAX_TOKENS;
  __setTestConfigDir(dir);
  try {
    delete process.env.PI_BLACKHOLE_RECALL_RESPONSE_MAX_TOKENS;
    mkdirSync(join(dir,'pi-blackhole'));
    const file = join(dir,'pi-blackhole/pi-blackhole-config.json');
    writeFileSync(file,JSON.stringify({recallResponseMaxChars:1000,recallResponseMaxTokens:80}));
    assert.equal(loadUnifiedConfig(dir).recallResponseMaxTokens,80);
    assert.equal(loadUnifiedConfig(dir).recallResponseMaxChars,1000);
    writeFileSync(file,JSON.stringify({recallResponseMaxTokens:0}));
    assert.equal(loadUnifiedConfig(dir).recallResponseMaxTokens,0);
    process.env.PI_BLACKHOLE_RECALL_RESPONSE_MAX_TOKENS='123';
    assert.equal(loadUnifiedConfig(dir).recallResponseMaxTokens,123);
  } finally {
    __setTestConfigDir(undefined);
    if(old === undefined) delete process.env.PI_BLACKHOLE_RECALL_RESPONSE_MAX_TOKENS; else process.env.PI_BLACKHOLE_RECALL_RESPONSE_MAX_TOKENS=old;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('real recall executor bounds search, expand, touched, drill-down and error outputs; config stays live', async () => {
  const dir=mkdtempSync(join(tmpdir(),'bh-recall-'));
  try {
    const file=join(dir,'session.jsonl');
    const entries=[{type:'session',version:3,id:'test',timestamp:'2026-09-16T00:00:00Z',cwd:dir},
      {type:'message',id:'m0',parentId:null,timestamp:'2026-09-16T00:00:00Z',message:{role:'user',content:'中文记录'.repeat(1000),timestamp:0}},
      {type:'message',id:'m1',parentId:'m0',timestamp:'2026-09-16T00:00:01Z',message:{role:'assistant',content:[{type:'toolCall',id:'tc',name:'write',arguments:{path:join(dir,'中文文件.ts'),content:'中文内容'.repeat(1000)}}],timestamp:1}},
    ];
    writeFileSync(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
    let tool: any;
    const runtime={config:{recallResponseMaxChars:1000,recallResponseMaxTokens:100}};
    registerRecallTool({registerTool:(t:any)=>{tool=t;}} as any,runtime);
    const ctx={sessionManager:{getSessionFile:()=>file,getBranch:()=>[]}};
    for(const params of [{query:'中文'},{expand:[0]},{mode:'touched'},{query:'#0:text:full'},{query:'#1:中文文件.ts:full'},{query:'不存在'.repeat(1000)},{query:'abcdefabcdef'}]) {
      const result=await tool.execute('test',{scope:'all',...params},undefined,undefined,ctx);
      const text=result.content.map((c:any)=>c.text).join('\n\n');
      assert.ok(text.length<=1000,JSON.stringify(params).slice(0,80));
      assert.ok(estimateStringTokens(text)<=100,JSON.stringify(params).slice(0,80));
    }
    runtime.config.recallResponseMaxTokens=0;
    runtime.config.recallResponseMaxChars=0;
    const result=await tool.execute('test',{query:'#0:text:full',scope:'all'},undefined,undefined,ctx);
    assert.ok(estimateStringTokens(result.content[0].text)>100);
    const expanded=await tool.execute('test',{query:'#0',scope:'all'},undefined,undefined,ctx);
    assert.ok(expanded.content[0].text.includes('中文记录'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('bounded recall handles tiny budgets and Unicode without overflow', () => {
  for(const chars of [0,1,2,10,80,200]) for(const tokens of [0,1,2,10,80,200]) {
    const source='中文😀hello\n'.repeat(100);
    const outputs=[capRecallBlocks({header:'标题'.repeat(200),entryBlocks:[source,source],tailBlocks:[source],budget:chars,tokenBudget:tokens,continuation:'下一页'.repeat(200)}).text,capRecallText(source,chars,tokens,'use #0:text:offset:limit')];
    for(const out of outputs) {
      assert.ok(chars===0||out.length<=chars);
      assert.ok(tokens===0||estimateStringTokens(out)<=tokens);
      assert.ok(!/[\uD800-\uDBFF]$/.test(out));
    }
  }
});

test('resolved subject clears only its own blocker; status and questions do not change goal', () => {
  const sections=buildSections({blocks:[{kind:'user',text:'请修复登录模块并补充中文测试。'}, {kind:'user',text:'登录模块仍然报错。'}, {kind:'user',text:'注册模块仍然报错。'}, {kind:'user',text:'登录模块已经修复。'}, {kind:'user',text:'是否应该改为删除所有测试文件'}]});
  assert.ok(!sections.outstandingContext.join('\n').includes('登录模块仍然报错'));
  assert.ok(sections.outstandingContext.join('\n').includes('注册模块仍然报错'));
  assert.ok(!sections.sessionGoal.join('\n').includes('[Scope change]'));
});

test('deterministic final summary preserves Chinese goals and constraints', () => {
  const text=formatSummary(buildSections({blocks:[{kind:'user',text:'请修复登录模块，禁止删除用户数据。'},{kind:'user',text:'改一下，现在我希望修复注册模块，并且永远使用中文回复。'},{kind:'user',text:'注册模块仍然报错。'}]}));
  for(const fact of ['注册模块','禁止删除用户数据','永远使用中文回复','注册模块仍然报错']) assert.ok(text.includes(fact));
});

test('usage only trusts successful assistant context accounting', () => {
  const usage={input:100,output:20,cacheRead:30,cacheWrite:10,totalTokens:160};
  assert.equal(getUsageTokens({role:'assistant',stopReason:'stop',usage}),160);
  assert.equal(getUsageTokens({role:'assistant',stopReason:'error',usage}),undefined);
  assert.equal(getUsageTokens({role:'toolResult',usage}),undefined);
});

test('Unicode estimates cover host summary and bash wrappers', () => {
  const body = '中文内容'.repeat(100);
  for (const message of [{role:'bashExecution', command:'echo', output:body}, {role:'compactionSummary',summary:body}, {role:'branchSummary',summary:body}]) {
    assert.ok(estimateEntryTokens({type:'message',message}) >= estimateStringTokens(body));
  }
  assert.ok(estimateStringTokens('😀𠮷') >= 8);
});

test('a resolved clause must not hide another unresolved blocker', () => {
  const sections = buildSections({blocks:[{kind:'user',text:'登录模块已经修复，但注册模块无法使用。'}]});
  assert.ok(sections.outstandingContext.join('\n').includes('注册模块无法使用'));
});

test('lazy observer, reflector and dropper modules resolve without model calls', async () => {
  const observer = await import('../src/om/agents/observer/agent');
  const reflector = await import('../src/om/agents/reflector/agent');
  const dropper = await import('../src/om/agents/dropper/agent');
  assert.equal(typeof observer.runObserver, 'function');
  assert.equal(typeof reflector.runReflector, 'function');
  assert.equal(typeof dropper.runDropper, 'function');
});
