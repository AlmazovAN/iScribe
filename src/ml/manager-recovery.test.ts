import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({
 backends:['webgpu','wasm'] as string[],
 preferences:[] as string[][],
 disposeCount:0,
 stallInit:false,
 pendingInit:false,
 resolveInit:null as null|((value:{active:string})=>void),
 terminatedWorkers:0,
 threadRequests:[] as number[],speakerMessages:[] as string[],finishSpeaker:false
}));
vi.mock('./worker?worker',()=>({default:class{
 private handler:((event:MessageEvent<unknown>)=>void)|undefined;
 addEventListener(type:string,handler:(event:MessageEvent<unknown>)=>void){if(type==='message')this.handler=handler}
 postMessage(data:{type?:string;requested?:number;requestId?:string}){
  if(data.type==='iscribe:speakers'&&state.finishSpeaker){
   state.speakerMessages.push(data.type);
   this.handler?.({data:{type:'iscribe:speaker-progress',requestId:data.requestId,status:'Поиск речи',percent:20}} as MessageEvent<unknown>);
   this.handler?.({data:{type:'iscribe:speaker-result',requestId:data.requestId,turns:[{start:0,end:1,speaker:'A'}]}} as MessageEvent<unknown>);return;
  }
  if(data.type!=='iscribe:wasm-threads'||typeof data.requested!=='number')return;
  if(state.finishSpeaker)state.speakerMessages.push(data.type);
  state.threadRequests.push(data.requested);
  this.handler?.({data:{type:'iscribe:wasm-thread-config',requested:data.requested,configured:data.requested}} as MessageEvent<unknown>);
 }
 terminate(){state.terminatedWorkers++}
}}));
vi.mock('@yourdevice/engine',()=>({
 EngineClient:class{
  onDownloadProgress:unknown;
  constructor(create:()=>unknown){create()}
  async init(_model:string,options?:{backendPreference?:string[]}){
   state.preferences.push(options?.backendPreference??[]);
   if(state.stallInit)return new Promise<{active:string}>(()=>{});
   if(state.pendingInit)return new Promise<{active:string}>(resolve=>{state.resolveInit=resolve});
   return {active:state.backends.shift()??'wasm'};
  }
  async transcribe(){return [{start:0,end:1,text:'recognized'}]}
  dispose(){state.disposeCount++}
 }
}));
vi.mock('./cache',()=>({
 checkWhisperCache:vi.fn(async()=>true),
 recordWhisperCache:vi.fn(async()=>true),
 checkSpeakerCache:vi.fn(async()=>true),
 speakerRepos:{segmentation:'test/seg',embedding:'test/emb'}
}));
import {ModelManager} from './manager';
import {checkWhisperCache} from './cache';
afterEach(()=>{vi.useRealTimers();state.stallInit=false;state.pendingInit=false;state.resolveInit=null;state.terminatedWorkers=0;state.finishSpeaker=false;state.speakerMessages=[]});
it('restarts failed accelerated inference with a new Worker and selects real WASM',async()=>{
 state.backends=['webgpu','wasm'];state.preferences=[];state.disposeCount=0;
 const manager=new ModelManager();
 expect((await manager.prepare('whisper-small')).backend).toBe('webgpu');
 expect((await manager.recover('whisper-small',true)).backend).toBe('wasm');
 expect(state.preferences).toEqual([[],['wasm']]);
 expect(state.disposeCount).toBeGreaterThan(0);
 manager.cancel();
});
it('rejects a disguised GPU fallback when WASM recovery was required',async()=>{
 state.backends=['webgpu','webgpu'];state.preferences=[];state.disposeCount=0;
 const manager=new ModelManager();
 await manager.prepare('whisper-small');
 await expect(manager.recover('whisper-small',true)).rejects.toThrow('WASM');
 expect(manager.active).toBeNull();
 expect(manager.capabilities).toBeNull();
 expect(state.preferences).toEqual([[],['wasm']]);
 manager.cancel();
});

it('rejects a full audio recording before it is copied into inference Worker memory',async()=>{
 state.backends=['wasm'];state.preferences=[];state.disposeCount=0;
 const manager=new ModelManager();
 await manager.prepare('whisper-small');
 await expect(manager.transcribe(new Float32Array(30*16000+1),false,()=>{})).rejects.toThrow('не более 30 секунд');
 await expect(manager.transcribe(new Float32Array(0),false,()=>{})).rejects.toThrow('не более 30 секунд');
 manager.cancel();
});

it('exposes truthful lifecycle transitions and actual backend, clearing both on cancellation',async()=>{
 state.backends=['webgpu'];state.preferences=[];state.disposeCount=0;
 const manager=new ModelManager(),seen:string[]=[];
 manager.onLifecycleChange=status=>seen.push(status.phase+':'+(status.backend??'none'));
 expect(await manager.prepare('whisper-small')).toMatchObject({backend:'webgpu'});
 expect(manager.lifecycle).toMatchObject({phase:'ready',backend:'webgpu',model:'whisper-small'});
 const text=await manager.transcribe(new Float32Array(16000),false,()=>{});
 expect(text).toHaveLength(1);
 expect(seen).toContain('transcribing:webgpu');
 expect(manager.lifecycle.phase).toBe('ready');
 manager.cancel();
 expect(manager.lifecycle).toMatchObject({phase:'cancelled',backend:null,model:null});
 expect(seen.at(-1)).toBe('cancelled:none');
});

it('releases an initializing session after inactivity instead of leaving the Worker busy forever',async()=>{
 vi.useFakeTimers();state.stallInit=true;state.disposeCount=0;
 const manager=new ModelManager({initIdleMs:40});
 const pending=manager.prepare('whisper-small');
 const assertion=expect(pending).rejects.toMatchObject({code:'worker-failed'});
 await vi.advanceTimersByTimeAsync(150);
 await assertion;
 expect(manager.active).toBeNull();
 expect(manager.capabilities).toBeNull();
 expect(manager.lifecycle.phase).toBe('error');
 expect(state.disposeCount).toBeGreaterThan(0);
 // The lifecycle lock must be released, so the user can retry from scratch.
 state.stallInit=false;state.backends=['wasm'];
 expect(await manager.prepare('whisper-small')).toMatchObject({backend:'wasm'});
 manager.cancel();
});

it('times out silent speaker-model preload and permits a clean later attempt',async()=>{
 vi.useFakeTimers();state.terminatedWorkers=0;
 const manager=new ModelManager({speakerIdleMs:35});
 const pending=manager.preloadSpeakers();
 const assertion=expect(pending).rejects.toMatchObject({code:'worker-failed'});
 await vi.advanceTimersByTimeAsync(110);
 await assertion;
 expect(manager.lifecycle).toMatchObject({phase:'error',backend:null});
 expect(state.terminatedWorkers).toBeGreaterThan(0);
 const again=manager.preloadSpeakers();
 const second=expect(again).rejects.toMatchObject({code:'worker-failed'});
 await vi.advanceTimersByTimeAsync(110);
 await second;
});

it('times out silent speaker diarization without resurrecting an ASR session',async()=>{
 vi.useFakeTimers();state.terminatedWorkers=0;
 const manager=new ModelManager({speakerIdleMs:40});
 const pending=manager.diarize(new Float32Array(16000));
 const assertion=expect(pending).rejects.toMatchObject({code:'worker-failed'});
 await vi.advanceTimersByTimeAsync(130);
 await assertion;
 expect(manager.active).toBeNull();
 expect(manager.capabilities).toBeNull();
 expect(manager.lifecycle).toMatchObject({phase:'error',backend:null});
 expect(state.terminatedWorkers).toBeGreaterThan(0);
});

it('ignores an old model-init completion after cancellation',async()=>{
 state.pendingInit=true;state.backends=['webgpu'];state.preferences=[];
 const manager=new ModelManager({initIdleMs:2000});
 const pending=manager.prepare('whisper-small');
 for(let i=0;i<12&&!state.resolveInit;i++)await Promise.resolve();
 expect(state.resolveInit).not.toBeNull();
 manager.cancel();
 state.resolveInit!({active:'webgpu'});
 await expect(pending).rejects.toThrow('отменена');
 expect(manager.active).toBeNull();
 expect(manager.capabilities).toBeNull();
 expect(manager.lifecycle).toMatchObject({phase:'cancelled',backend:null,model:null});
});

it('does not report a cached active model as ready when it was cancelled during cache check',async()=>{
 state.backends=['webgpu'];
 const manager=new ModelManager();
 await manager.prepare('whisper-small');
 let release:(cached:boolean)=>void=()=>{};
 vi.mocked(checkWhisperCache).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
 const progress=vi.fn();
 manager.onWhisperProgress=progress;
 const pending=manager.prepare('whisper-small');
 for(let i=0;i<8;i++)await Promise.resolve();
 manager.cancel();
 release(true);
 await expect(pending).rejects.toThrow('Операция отменена');
 expect(manager.active).toBeNull();
 expect(manager.lifecycle.phase).toBe('cancelled');
 expect(progress.mock.calls.some(([,result])=>result.phase==='ready')).toBe(false);
});

it('requests a specific backend and rejects a different provider',async()=>{
 state.backends=['webgpu','webnn','wasm'];state.preferences=[];state.disposeCount=0;
 const manager=new ModelManager();
 expect((await manager.prepare('whisper-small',{backend:'webgpu'})).backend).toBe('webgpu');
 expect((await manager.prepare('whisper-small',{backend:'webnn'})).backend).toBe('webnn');
 await expect(manager.prepare('whisper-small',{backend:'webgpu'})).rejects.toThrow('WEBGPU');
 expect(state.preferences).toEqual([['webgpu'],['webnn'],['webgpu']]);
 expect(manager.active).toBeNull();manager.cancel();
});

it('configures WASM before initialization and refreshes only on a changed thread target',async()=>{
 const manager=new ModelManager();
 const target=vi.spyOn(manager,'targetWasmThreads','get');
 target.mockReturnValue(4);state.backends=['wasm','wasm'];state.preferences=[];state.threadRequests=[];
 await manager.prepare('whisper-small',{backend:'wasm'});
 expect(manager.wasmThreadConfiguration).toEqual({requested:4,configured:4});
 expect(manager.needsWasmThreadRefresh()).toBe(false);
 await manager.prepare('whisper-small',{backend:'wasm'});
 expect(state.threadRequests).toEqual([4]);
 target.mockReturnValue(1);expect(manager.needsWasmThreadRefresh()).toBe(true);
 await manager.prepare('whisper-small',{backend:'wasm'});
 expect(state.threadRequests).toEqual([4,1]);
 expect(manager.wasmThreadConfiguration).toEqual({requested:1,configured:1});
 manager.cancel();expect(manager.wasmThreadConfiguration).toBeNull();
 target.mockRestore();
});

it('configures independent speaker Worker before dispatch and records acknowledgement',async()=>{
 const manager=new ModelManager();
 vi.spyOn(manager,'targetWasmThreads','get').mockReturnValue(4);
 state.finishSpeaker=true;state.speakerMessages=[];state.threadRequests=[];
 expect(await manager.diarize(new Float32Array(16000))).toEqual([{start:0,end:1,speaker:'A'}]);
 expect(state.speakerMessages).toEqual(['iscribe:wasm-threads','iscribe:speakers']);
 expect(manager.lastSpeakerPass).toMatchObject({status:'passed',requestedBackend:'wasm',dtype:'q8',threads:{requested:4,configured:4},audioSeconds:1,progressEvents:1});
 expect(manager.active).toBeNull();expect(manager.lifecycle.phase).toBe('idle');
});
