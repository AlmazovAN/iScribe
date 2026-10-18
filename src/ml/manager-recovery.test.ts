import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({
 backends:['webgpu','wasm'] as string[],
 preferences:[] as string[][],
 disposeCount:0
}));
vi.mock('./worker?worker',()=>({default:class{}}));
vi.mock('@yourdevice/engine',()=>({
 EngineClient:class{
  onDownloadProgress:unknown;
  constructor(create:()=>unknown){create()}
  async init(_model:string,options?:{backendPreference?:string[]}){
   state.preferences.push(options?.backendPreference??[]);
   return {active:state.backends.shift()??'wasm'};
  }
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
