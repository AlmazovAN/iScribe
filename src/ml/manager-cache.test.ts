import {expect,it,vi} from 'vitest';
const ctx=vi.hoisted(()=>({initCount:0,disposeCount:0,cache:true}));
vi.mock('./worker?worker',()=>({default:class {
 addEventListener(){/* EngineClient mock does not require worker events. */}
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
