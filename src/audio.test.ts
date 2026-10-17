import {expect,it} from 'vitest';
import {mixMono,validateFile,MAX_FILE_BYTES} from './audio';
it('averages channels without changing sample positions or mutating input',()=>{
 const left=Float32Array.of(1,0,-1),right=Float32Array.of(0,1,1);
 expect([...mixMono([left,right])]).toEqual([.5,.5,0]);expect([...left]).toEqual([1,0,-1]);
});
it('rejects malformed input channels',()=>{expect(()=>mixMono([])).toThrow();expect(()=>mixMono([Float32Array.of(1),Float32Array.of(1,2)])).toThrow()});
it('rejects empty, oversized and unsupported files',()=>{
 expect(()=>validateFile({name:'note.wav',size:0})).toThrow();
 expect(()=>validateFile({name:'note.mp3',size:MAX_FILE_BYTES+1})).toThrow();
 expect(()=>validateFile({name:'note.exe',size:10})).toThrow();
 expect(()=>validateFile({name:'NOTE.WAV',size:100})).not.toThrow();
});
