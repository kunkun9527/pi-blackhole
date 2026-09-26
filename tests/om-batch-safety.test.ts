import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runReflector } from '../src/om/agents/reflector/agent';
import { runDropper, maxDropCountForPool } from '../src/om/agents/dropper/agent';
import { buildCompactionProjection, OM_OBSERVATIONS_RECORDED } from '../src/om/ledger/index';
import { summarizeCoverageByRelevance } from '../src/om/agents/dropper/coverage';
import { estimateStringTokens } from '../src/om/tokens';
import { agentCompletionError, InputBudgetError } from '../src/om/input-budget';
const model:any={id:'offline',provider:'offline',api:'openai-completions',contextWindow:20000,maxTokens:1000};
const obs=(i:number)=>({id:String(i).padStart(12,'0'),content:'中文'.repeat(600),timestamp:'2026-09-16',relevance:'medium' as const,sourceEntryIds:['source'],tokenCount:1});
const noNetwork=()=>{throw new Error('network forbidden');};
const idsOf=(prompts:any[])=>[...prompts[0].content[0].text.matchAll(/\[([a-f0-9]{12})\]/g)].map((m:any)=>m[1]);
function loopWith(fn:(prompts:any[],ctx:any,streamFn:any)=>Promise<any[]>) {
  return ((prompts:any[],ctx:any,_config:any,_signal:any,streamFn:any)=>{
    const stream:any=(async function*(){yield {type:'agent_end',messages:await fn(prompts,ctx,streamFn)};})();
    stream.result=async()=>[];return stream;
  }) as any;
}

test('legacy tokenCount never drives pool pressure or coverage statistics',()=>{
  const observation=obs(1);
  const entries:any[]=[{id:'source',type:'message',message:{role:'user',content:'hello'}},{id:'marker',type:'custom',customType:OM_OBSERVATIONS_RECORDED,data:{observations:[observation],coversUpToId:'source'}}];
  const before=JSON.stringify(entries);
  assert.equal(buildCompactionProjection(entries,'',{observationsPoolMaxTokens:1000}).fullFold,true);
  const summary=summarizeCoverageByRelevance([observation],new Map());
  assert.equal(summary.medium.none.tokens,estimateStringTokens(observation.content));
  assert.equal(JSON.stringify(entries),before,'read-time recalculation must not rewrite historical records');
});

test('reflection batch aggregation preserves all supporting source observations',async()=>{
  const observations=Array.from({length:12},(_,i)=>obs(i));let calls=0;
  const loop=loopWith(async(prompts,ctx)=>{
    calls++;
    await ctx.tools[0].execute('r',{reflections:[{content:'同一完整事实',supportingObservationIds:idsOf(prompts)}]});
    return [{stopReason:'stop'}];
  });
  const result=await runReflector({model,apiKey:'offline',inputMaxTokens:7000,observations,reflections:[],agentLoop:loop,streamFn:noNetwork});
  assert.ok(calls>1);assert.equal(result?.length,1);
  assert.deepEqual(new Set(result![0].supportingObservationIds),new Set(observations.map(o=>o.id)));
});

test('a later batch failure rejects the entire reflector result',async()=>{
  let calls=0;
  const loop=loopWith(async(prompts,ctx)=>{
    calls++;
    if(calls===2)throw new Error('second batch failed');
    await ctx.tools[0].execute('r',{reflections:[{content:'partial result',supportingObservationIds:idsOf(prompts)}]});
    return [{stopReason:'stop'}];
  });
  await assert.rejects(runReflector({model,apiKey:'offline',inputMaxTokens:7000,observations:Array.from({length:12},(_,i)=>obs(i)),reflections:[],agentLoop:loop,streamFn:noNetwork}),/second batch failed/);
  assert.equal(calls,2);
});

test('dropper final global cap is not multiplied by number of batches',async()=>{
  const observations=Array.from({length:15},(_,i)=>obs(i));let calls=0;
  const loop=loopWith(async(prompts,ctx)=>{calls++;await ctx.tools[0].execute('d',{ids:idsOf(prompts)});return [{stopReason:'stop'}];});
  const budget=100;
  const dropped=await runDropper({model,apiKey:'offline',inputMaxTokens:7000,observations,reflections:[],budgetTokens:budget,agentLoop:loop,streamFn:noNetwork});
  const globalCap=maxDropCountForPool(observations,observations.reduce((s,o)=>s+estimateStringTokens(o.content),0),budget);
  assert.ok(calls>1);assert.equal(dropped?.length,globalCap);assert.equal(new Set(dropped).size,dropped?.length);
});

test('budget errors survive agent-loop conversion into assistant error messages',async()=>{
  const loop=loopWith(async(_prompts,ctx,streamFn)=>{
    // pi 0.87 does not catch stream-function throws; the refusal must arrive as an error stream.
    const refused=await streamFn(model,{...ctx,messages:[{role:'user',content:'中文'.repeat(10000)}]},{}).result();
    assert.equal(refused.stopReason,'error');
    return [refused];
  });
  await assert.rejects(runReflector({model,apiKey:'offline',inputMaxTokens:7000,observations:[obs(1)],reflections:[],agentLoop:loop,streamFn:noNetwork}),InputBudgetError);
});

test('aborted, output-limited and unfinished tool responses are not completed coverage',()=>{
  for(const stopReason of ['aborted','length','toolUse','error']) {
    assert.ok(agentCompletionError([{role:'assistant',stopReason},{role:'toolResult',content:[]}]),stopReason);
  }
  assert.equal(agentCompletionError([{role:'assistant',stopReason:'stop'}]),undefined);
  // 0.5.9 complete=true early stop ends on toolUse; only a terminating tool batch may pass.
  assert.equal(agentCompletionError([{role:'assistant',stopReason:'toolUse'}],undefined,true),undefined);
  assert.match(agentCompletionError([{role:'assistant',stopReason:'error',errorMessage:'boom'}],undefined,true)??'',/boom/);
});

test('manual-mode pending batches preserve every source without live-session writes',()=>{
  const result=spawnSync('bun',[fileURLToPath(new URL('../scripts/smoke-om-manual.ts',import.meta.url))],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr || String(result.error));
  assert.match(result.stdout,/all three source batches retained/);
});
