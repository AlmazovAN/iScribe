import {expect,it,vi} from 'vitest';
import {AudioPipeline} from './audioPipeline';
it('serializes producer, bounds queue and consumes in FIFO order',async()=>{
 const p=new AudioPipeline<number>(new AbortController().signal);
 let release:(value:number)=>void=()=>{};
 const load=vi.fn((index:number)=>index===1?new Promise<number>(resolve=>{release=resolve}):Promise.resolve(index));
 expect(p.fill(1,99,load)).toBe(2);expect(p.size).toBe(2);
 await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
 expect(p.fill(1,2,load)).toBe(0);
 await expect(p.take(2)).rejects.toThrow('последовательность');
 release(1);expect((await p.take(1))?.result).toEqual({ok:true,value:1});
 expect((await p.take(2))?.result).toEqual({ok:true,value:2});
 expect(load).toHaveBeenCalledTimes(2);expect(p.size).toBe(0);
 await p.dispose();
});
it('does not start another read after producer failure',async()=>{
 const p=new AudioPipeline<number>(new AbortController().signal);
 const load=vi.fn(async()=>{throw new Error('decode')});
 p.fill(1,2,load);
 expect((await p.take(1))?.result.ok).toBe(false);
 await p.dispose();expect(load).toHaveBeenCalledTimes(1);expect(p.size).toBe(0);
 expect(p.fill(3,2,load)).toBe(0);
});
it('cancellation discards queued work and prevents additional reads',async()=>{
 const c=new AbortController(),p=new AudioPipeline<number>(c.signal);
 const load=vi.fn((_index:number,signal:AbortSignal)=>new Promise<number>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
 p.fill(1,2,load);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
 c.abort();await p.dispose();
 expect(load).toHaveBeenCalledTimes(1);expect(p.size).toBe(0);
});
