import {expect,it,vi} from 'vitest';
const ctx=vi.hoisted(()=>({initCount:0,disposeCount:0,cache:true,terminateFails:false,terminateCount:0}));
vi.mock('./worker?worker',()=>({default:class {
 addEventListener(){/* EngineClient mock does not require worker events. */}
 terminate(){ctx.terminateCount++;if(ctx.terminateFails)throw new Error('injected Worker termination failure')}
}}));
vi.mock('@yourdevice/engine',()=>({EngineClient:class {
 onDownloadProgress:unknown;
 constructor(_factory:()=>unknown){_factory()}
 async init(){ctx.initCount++;return {active:'wasm'}}
 dispose(){ctx.disposeCount++}
}}));
vi.mock('./cache',()=>({
 checkWhisperCache:vi.fn(async()=>ctx.cache),
 recordWhisperCache:vi.fn(async()=>ctx.cache),
 checkSpeakerCache:vi.fn(async()=>true),
 speakerRepos:{segmentation:'seg',embedding:'emb'}
}));
import {ModelManager} from './manager';
it('does not recreate an ONNX session when the already active Whisper model is selected',async()=>{
 ctx.initCount=0;ctx.disposeCount=0;ctx.cache=true;
 const manager=new ModelManager();
 const events:string[]=[];manager.onWhisperProgress=(_id,event)=>events.push(event.phase);
 await manager.prepare('whisper-small');
 await manager.prepare('whisper-small');
 expect(ctx.initCount).toBe(1);
 expect(ctx.disposeCount).toBe(0);
 expect(events).toContain('initializing');
 expect(events.at(-1)).toBe('ready');
 manager.cancel();
});
it('reports readiness without pretending the cache exists',async()=>{
 ctx.initCount=0;ctx.cache=false;
 const manager=new ModelManager();
 let saved:boolean|undefined;
 manager.onWhisperProgress=(_id,event)=>{if(event.phase==='ready')saved=event.cachedAfter};
 await manager.prepare('whisper-tiny');
 expect(saved).toBe(false);
 expect(manager.active).toBe('whisper-tiny');
 manager.cancel();
});

it('releases idle sessions without dropping the model cache or recreating a disposed client',async()=>{
 ctx.initCount=0;ctx.disposeCount=0;ctx.cache=true;
 const manager=new ModelManager();
 await manager.prepare('whisper-small');
 expect(manager.releaseIdle()).toBe(true);
 expect(manager.active).toBeNull();expect(manager.lifecycle.phase).toBe('idle');
 expect(manager.releaseIdle()).toBe(false);expect(ctx.disposeCount).toBe(1);
 expect(await manager.cached('whisper-small')).toBe(true);
 await manager.prepare('whisper-small');expect(ctx.initCount).toBe(2);manager.cancel();
});

it('PIPE-06 refuses model allocation after an unconfirmed retirement, even after cancellation',async()=>{
 ctx.initCount=0;ctx.disposeCount=0;ctx.terminateCount=0;ctx.cache=true;ctx.terminateFails=false;
 const manager=new ModelManager();
 try{
  await manager.prepare('whisper-small');ctx.terminateFails=true;
  expect(()=>manager.releaseIdle()).toThrow('Не подтверждено');
  expect(manager.active).toBeNull();expect(manager.resourceBlocked).toBe(true);
  await expect(manager.prepare('whisper-tiny')).rejects.toMatchObject({code:'worker-disposal-failed'});
  manager.cancel();await expect(manager.recover('whisper-small',true)).rejects.toMatchObject({code:'worker-disposal-failed'});
  expect(ctx.initCount).toBe(1);expect(ctx.terminateCount).toBe(1);
 }finally{ctx.terminateFails=false}
});
