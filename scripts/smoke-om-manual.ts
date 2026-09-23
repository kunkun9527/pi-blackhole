// Isolated manual-mode coverage test. No provider calls and no real session writes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'bh-manual-budget-'));
process.env.PI_CODING_AGENT_DIR=dir;
try {
  const {runObserverStage}=await import('../src/om/consolidation');
  const {readPendingState}=await import('../src/om/pending');
  const {DEFAULTS}=await import('../src/core/unified-config');
  const {isObservationsRecordedData}=await import('../src/om/ledger/index');
  const {hashId}=await import('../src/om/ids');
  const entries=Array.from({length:3},(_,i)=>({id:'s'+i,type:'message',message:{role:'user',content:'中文'.repeat(800),timestamp:0}}));
  let cursor:any;const warnings:any[]=[];
  const runtime:any={config:{...DEFAULTS,compaction:'manual',observeAfterTokens:3000,observerChunkMaxTokens:8000},
    isGenerationActive:()=>true,getCursor:()=>cursor,advanceCursor:(_s:any,entryId:string,state:string)=>{cursor={entryId,state};},
    tryEmitInfo:()=>{},findCandidateConfig:()=>undefined,recordRetryableError:(_c:any,e:any)=>{throw e;},recordDeterministicError:()=>{},recordConsolidationStageError:(_c:any,_s:any,e:any)=>warnings.push(e)};
  const pi:any={appendEntry:()=>{throw new Error('manual mode must not append to branch');}};
  const ctx:any={hasUI:false,sessionManager:{getBranch:()=>entries,getSessionId:()=> 'manual-test'}};
  const model:any={id:'offline',provider:'offline',contextWindow:20000,maxTokens:1000};
  const runAgent:any=async(args:any)=>({observations:[{id:hashId('fact '+args.allowedSourceEntryIds[0]),content:'fact '+args.allowedSourceEntryIds[0],timestamp:'2026-09-16',sourceEntryIds:args.allowedSourceEntryIds,relevance:'high',tokenCount:3}]});
  await runObserverStage(pi,runtime,ctx,{signal:new AbortController().signal} as any,async()=>({ok:true,model,apiKey:'offline'}),runAgent);
  assert.deepEqual(warnings,[]);
  const state=readPendingState('manual-test');
  assert.deepEqual(state.observationBatches?.map(b=>b.coversUpToId),['s0','s1','s2']);
  assert.deepEqual(state.observationBatches?.flatMap(b=>{
    assert.ok(isObservationsRecordedData(b.data));
    return b.data.observations.flatMap(o=>o.sourceEntryIds);
  }),['s0','s1','s2']);
  assert.equal(cursor.entryId,'s2');
  console.log('Manual mode: all three source batches retained, no branch append and no source skipped.');
} finally { rmSync(dir,{recursive:true,force:true}); }
