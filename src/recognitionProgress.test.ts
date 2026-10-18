import {expect,it} from 'vitest';
import {audioWindows,absoluteSegments} from './jobs';
import {checkpointProgress,checkpointLabel,currentWindowLabel} from './recognitionProgress';
it('shows the entire 14m31s recording instead of restarting at 3 seconds each window',()=>{
 const windows=audioWindows(871*16000);
 expect(windows).toHaveLength(35);
 expect(checkpointProgress(windows,0)).toMatchObject({seconds:0,totalSeconds:871,completedWindows:0,totalWindows:35,percent:0});
 expect(checkpointProgress(windows,1).seconds).toBe(30);
 expect(checkpointProgress(windows,2).seconds).toBe(55);
 expect(checkpointProgress(windows,35)).toMatchObject({seconds:871,percent:100});
 expect(checkpointLabel(checkpointProgress(windows,2))).toContain('00:55 / 14:31');
 expect(currentWindowLabel(windows,2)).toContain('окно 3/35');
});
it('counts short final windows by actual audio end, not by 30s or equal window weights',()=>{
 const windows=audioWindows(56*16000);
 expect(windows).toHaveLength(3);
 expect(checkpointProgress(windows,2).seconds).toBe(55);
 expect(checkpointProgress(windows,2).percent).toBeCloseTo(55/56*100);
 expect(checkpointProgress(windows,3).percent).toBe(100);
});
it('rejects checkpoints outside the planned window range',()=>{
 const windows=audioWindows(60*16000);
 expect(()=>checkpointProgress(windows,-1)).toThrow('контрольная точка');
 expect(()=>checkpointProgress(windows,4)).toThrow('контрольная точка');
 expect(()=>checkpointProgress(windows,0.5)).toThrow('контрольная точка');
});
it('overlap-midpoint boundary retains each segment exactly once across two windows',()=>{
 const windows=audioWindows(60*16000);
 // Times in each inference window are RELATIVE. Shared audio has two
 // predictions; only the midpoint-assigned window is committed.
 const a=absoluteSegments([{start:26,end:27,text:'left'},{start:28,end:29,text:'duplicate-right'}],windows[0]);
 const b=absoluteSegments([{start:1,end:2,text:'duplicate-left'},{start:3,end:4,text:'right'}],windows[1]);
 expect(a.map(x=>x.text)).toEqual(['left']);
 expect(b.map(x=>x.text)).toEqual(['right']);
 expect([...a,...b].map(x=>x.start)).toEqual([26,28]);
});
