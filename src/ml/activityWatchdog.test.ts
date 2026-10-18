import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_ASR_IDLE_MS,MAX_ASR_WINDOW_SAMPLES,WorkerStalledError,withActivityWatchdog} from './activityWatchdog';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});
it('allows slow but responsive foreground inference without killing the worker',async()=>{
 vi.useFakeTimers();
 let done:(value:string)=>void=()=>{};
 const timeout=vi.fn(),promise=withActivityWatchdog<string>(()=>new Promise(()=>{}),{timeoutMs:100,pollMs:10,visibility:null,onTimeout:timeout});
 const stalled=expect(promise).rejects.toBeInstanceOf(WorkerStalledError);
 // Exercise heartbeat via a second, independently guarded task.
 let beat:()=>void=()=>{};
 const observed=withActivityWatchdog<string>(heartbeat=>{beat=heartbeat;return new Promise(resolve=>{done=resolve})},{timeoutMs:100,pollMs:10,visibility:null,onTimeout:timeout});
 for(let n=0;n<5;n++){await vi.advanceTimersByTimeAsync(70);beat()}
 done('ok');
 await expect(observed).resolves.toBe('ok');
 await stalled;
 expect(timeout).toHaveBeenCalledTimes(1);
});
it('pauses the idle clock in a hidden tab rather than treating throttling as a hang',async()=>{
 vi.useFakeTimers();
 let mode:Document['visibilityState']='visible',listener:()=>void=()=>{},done:(value:number)=>void=()=>{};
 const visibility={
  get visibilityState(){return mode},
  addEventListener:(_type:string,cb:EventListenerOrEventListenerObject)=>{listener=()=>{if(typeof cb==='function')cb(new Event('visibilitychange'))}},
  removeEventListener:()=>{}
 } as unknown as Pick<Document,'visibilityState'|'addEventListener'|'removeEventListener'>;
 const timeout=vi.fn();
 const result=withActivityWatchdog<number>(()=>new Promise(resolve=>{done=resolve}),{timeoutMs:100,pollMs:10,visibility,onTimeout:timeout});
 await vi.advanceTimersByTimeAsync(40);
 mode='hidden';listener();
 await vi.advanceTimersByTimeAsync(1000);
 expect(timeout).not.toHaveBeenCalled();
 mode='visible';listener();
 await vi.advanceTimersByTimeAsync(50);
 expect(timeout).not.toHaveBeenCalled();
 done(7);
 await expect(result).resolves.toBe(7);
 expect(DEFAULT_ASR_IDLE_MS).toBeGreaterThan(100000);
 expect(MAX_ASR_WINDOW_SAMPLES).toBe(480000);
});
it('terminates stalled work exactly once and rejects with retryable Worker code',async()=>{
 vi.useFakeTimers();
 const timeout=vi.fn();
 const promise=withActivityWatchdog(()=>new Promise<void>(()=>{}),{timeoutMs:40,pollMs:10,visibility:null,onTimeout:timeout});
 const assertion=expect(promise).rejects.toMatchObject({code:'worker-failed'});
 await vi.advanceTimersByTimeAsync(45);
 await assertion;
 await vi.advanceTimersByTimeAsync(200);
 expect(timeout).toHaveBeenCalledTimes(1);
});
it('honours user cancellation immediately and does not call the timeout handler',async()=>{
 vi.useFakeTimers();
 const controller=new AbortController(),timeout=vi.fn();
 const result=withActivityWatchdog(()=>new Promise<void>(()=>{}),{timeoutMs:20,pollMs:5,visibility:null,signal:controller.signal,onTimeout:timeout});
 const assertion=expect(result).rejects.toThrow('Отменено');
 controller.abort();
 await assertion;
 await vi.advanceTimersByTimeAsync(100);
 expect(timeout).not.toHaveBeenCalled();
});
