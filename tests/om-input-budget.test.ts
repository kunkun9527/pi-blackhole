import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runObserverStage } from '../src/om/consolidation';
import { runObserver, prepareObserverInput } from '../src/om/agents/observer/agent';
import { runReflector } from '../src/om/agents/reflector/agent';
import { runDropper } from '../src/om/agents/dropper/agent';
import { agentInputTokens, agentInputLimit, budgetedStream, InputBudgetError } from '../src/om/input-budget';
import { DEFAULTS } from '../src/core/unified-config';
import { estimateStringTokens } from '../src/om/tokens';
const model:any={id:'offline',provider:'offline',api:'openai-completions',contextWindow:20000,maxTokens:1000,reasoning:false};
const observation=(i:number,text='中文'.repeat(600))=>({id:String(i).padStart(12,'0'),content:text,timestamp:'2026-09-16',relevance:'medium' as const,sourceEntryIds:['source'],tokenCount:1});
function captureLoop(captured:any[], onRequest?:(ctx:any,prompt:any[])=>Promise<void>) {
  return ((prompts:any[],context:any,config:any,_signal:any,streamFn:any)=>{
    captured.push({prompts,context,config,streamFn});
    const stream:any=(async function*(){
      if(onRequest) await onRequest(context,prompts);
      yield {type:'agent_end',messages:[{stopReason:'stop'}]};
    })(); stream.result=async()=>[]; return stream;
  }) as any;
}
const noNetwork=()=>{throw new Error('network forbidden');};

test('observer never moves coverage past unseen source entries',async()=>{
  const entries:any[]=Array.from({length:3},(_,i)=>({id:'s'+i,type:'message',message:{role:'user',content:'中文'.repeat(800),timestamp:0}}));
  const seen:string[]=[]; const errors:Error[]=[]; let cursor:any;
  const runtime:any={config:{...DEFAULTS,compaction:'auto',observeAfterTokens:3000,observerChunkMaxTokens:8000},
    isGenerationActive:()=>true,getCursor:()=>cursor,advanceCursor:(_s:any,id:string,state:string)=>{cursor={entryId:id,state};},
    tryEmitInfo:()=>{},findCandidateConfig:()=>undefined,recordRetryableError:(_c:any,e:any)=>{throw e;},recordDeterministicError:()=>{},recordConsolidationStageError:(_c:any,_s:any,e:Error)=>errors.push(e)};
  const writes:any[]=[]; const pi:any={appendEntry:(customType:string,data:any)=>{
    writes.push(data); entries.push({id:'marker'+writes.length,type:'custom',customType,data});
  }};
  const ctx:any={hasUI:false,sessionManager:{getBranch:()=>entries,getSessionId:()=> 'budget-test'}};
  const generation:any={signal:new AbortController().signal};
  const fakeAgent:any=async(args:any)=>{
    seen.push(...args.allowedSourceEntryIds);
    return {observations:[{...observation(seen.length,'observed '+args.allowedSourceEntryIds[0]),sourceEntryIds:args.allowedSourceEntryIds}]};
  };
  // One invocation must drain the backlog, including a final chunk below the trigger threshold.
  await runObserverStage(pi,runtime,ctx,generation,async()=>({ok:true,model,apiKey:'offline'}),fakeAgent);
  assert.deepEqual(errors,[]);assert.deepEqual(seen,['s0','s1','s2']);assert.equal(cursor.entryId,'s2');
  assert.equal(writes[0].coversUpToId,'s0');
  const before=cursor;
  entries.push({id:'oversized',type:'message',message:{role:'user',content:'中文'.repeat(10000),timestamp:0}});
  assert.equal(await runObserverStage(pi,runtime,ctx,generation,async()=>({ok:true,model,apiKey:'offline'}),fakeAgent),'abort');
  assert.equal(cursor,before);assert.equal(errors.length,1);assert.match((errors[0] as Error).message,/retained.*not advanced/);
});

test('reflector batches all candidates using final prompt size, not capped counters',async()=>{
  const captured:any[]=[];const observations=Array.from({length:15},(_,i)=>observation(i));
  await runReflector({model,apiKey:'offline',inputMaxTokens:7000,reflections:[],observations,agentLoop:captureLoop(captured),streamFn:noNetwork});
  assert.ok(captured.length>1);
  const joined=captured.map(c=>c.prompts[0].content[0].text).join('\n');
  for(const obs of observations)assert.equal(joined.split(`[${obs.id}]`).length-1,1);
  for(const c of captured) {
    assert.ok(agentInputTokens('',c.context.tools,[...c.context.messages,...c.prompts])<=5600);
    // A normal tool turn can be appended without immediately exhausting the input cap.
    assert.ok(agentInputTokens('',c.context.tools,[...c.context.messages,...c.prompts,{role:'assistant',content:[{type:'text',text:'观察'.repeat(250)}]}])<=7000);
  }
});

test('oversized candidates fail before any model call, including a later oversized item',async()=>{
  const captured:any[]=[];
  await assert.rejects(runReflector({model,apiKey:'offline',inputMaxTokens:7000,reflections:[],observations:[observation(1),observation(2,'中文'.repeat(10000))],agentLoop:captureLoop(captured),streamFn:noNetwork}),InputBudgetError);
  assert.equal(captured.length,0);
});

test('dropper bounds reflections and candidates and keeps global drop limits',async()=>{
  const captured:any[]=[];const observations=Array.from({length:15},(_,i)=>observation(i));
  const reflections=Array.from({length:30},(_,i)=>({id:'r'+i,content:'中文'.repeat(1000),supportingObservationIds:[],tokenCount:1}));
  await runDropper({model,apiKey:'offline',inputMaxTokens:7000,reflections,observations,budgetTokens:100,agentLoop:captureLoop(captured),streamFn:noNetwork});
  assert.ok(captured.length>1);
  for(const c of captured){assert.ok(agentInputTokens('',c.context.tools,[...c.context.messages,...c.prompts])<=7000);assert.match(c.prompts[0].content[0].text,/context omitted/);}
  const joined=captured.map(c=>c.prompts[0].content[0].text).join('\n');
  for(const obs of observations)assert.equal(joined.split(`[${obs.id}]`).length-1,1);
});

test('observer planner accounts for wrappers, prior context and output reserve',()=>{
  const entries=Array.from({length:3},(_,i)=>({id:'s'+i,type:'message',message:{role:'user',content:'中文'.repeat(800),timestamp:0}}));
  const planned=prepareObserverInput(entries,model,{inputMaxTokens:8000},['上下文'.repeat(5000)],[]);
  assert.deepEqual(planned.sourceEntryIds,['s0']);
  assert.match(planned.priorReflections.join(''),/omitted/);
  assert.equal(agentInputLimit(model,{inputMaxTokens:999999},80000),17976);
});

test('each subsequent stream request is checked before reaching provider',()=>{
  let calls=0;const guarded=budgetedStream(()=>{calls++;return null;},1000);
  assert.throws(()=>guarded(model,{messages:[{role:'user',content:'中文'.repeat(1000)}]},{}),InputBudgetError);
  assert.equal(calls,0);
});

test('a failure after recording partial observations must not report successful coverage',async()=>{
  const loop:any=(prompts:any[],context:any)=>{
    const stream:any=(async function*(){
      await context.tools[0].execute('t',{observations:[{content:'partial',relevance:'high',sourceEntryIds:['s']}]});
      yield {type:'agent_end',messages:[{stopReason:'error',errorMessage:'offline simulated failure'}]};
    })();stream.result=async()=>[];return stream;
  };
  await assert.rejects(runObserver({model,apiKey:'offline',chunk:'[Source entry id: s] source text',allowedSourceEntryIds:['s'],priorReflections:[],priorObservations:[],agentLoop:loop,streamFn:noNetwork}),/offline simulated failure/);
});
