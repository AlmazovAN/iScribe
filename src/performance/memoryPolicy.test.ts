import {expect,it} from 'vitest';
import {AsrPayloadPool,shouldReleaseAfterQueue,observePayload,memoryReport} from './memoryPolicy';
it('reuses one exact-sized dispatch buffer without modifying source PCM',()=>{
 const pool=new AsrPayloadPool(),source=Float32Array.of(1,2,3,4);
 const a=pool.acquire(source.subarray(1,3));expect(a.reused).toBe(false);
 expect(a.payload.buffer.byteLength).toBe(8);expect([...a.payload]).toEqual([2,3]);
 expect(pool.retain(a.payload)).toBe('retained');
 const b=pool.acquire(source.subarray(0,2));expect(b.reused).toBe(true);expect(b.payload).toBe(a.payload);
 expect([...b.payload]).toEqual([1,2]);expect([...source]).toEqual([1,2,3,4]);
 pool.clear();expect(pool.acquire(source.subarray(0,2)).reused).toBe(false);
});
it('does not reuse detached or differently-sized payloads',()=>{
 const pool=new AsrPayloadPool(),source=Float32Array.of(1,2,3);
 const a=pool.acquire(source);
 structuredClone(a.payload,{transfer:[a.payload.buffer]});
 expect(pool.retain(a.payload)).toBe('detached');
 const b=pool.acquire(source);expect(b.reused).toBe(false);
 expect([...b.payload]).toEqual([1,2,3]);pool.retain(b.payload);
 expect(pool.acquire(source.subarray(0,1)).reused).toBe(false);
});
it('uses conservative idle release policy and exports allocation counters',()=>{
 expect(shouldReleaseAfterQueue('medium',8,'whisper-small')).toBe(true);
 expect(shouldReleaseAfterQueue('max',null,'whisper-small')).toBe(true);
 expect(shouldReleaseAfterQueue('max',16,'whisper-small')).toBe(false);
 expect(shouldReleaseAfterQueue('eco',16,'whisper-small')).toBe(true);
 expect(shouldReleaseAfterQueue('max',32,'whisper-large-v3')).toBe(true);
 expect(shouldReleaseAfterQueue('eco',4,null)).toBe(false);
 const a=observePayload(undefined,false,120),b=observePayload(a,true,120);
 expect(memoryReport(b)).toMatchObject({payloadAllocations:1,payloadReuses:1,payloadCopyBytes:240,peakPayloadBytes:120});
});
