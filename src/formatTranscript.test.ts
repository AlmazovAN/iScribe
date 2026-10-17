import {expect,it} from 'vitest';
import {formatTime,formatTranscript,transcriptBlob,transcriptFilename} from './formatTranscript';
const segments=[{start:309,end:310,text:'Продолжение следует...',speaker:'B'},{start:5,end:6,text:'Угу.',speaker:'B'},{start:606,end:608,text:'Саша, я сейчас вернусь.',speaker:'A'},{start:609,end:610,text:'Угу.',speaker:'B'}];
it('matches the contract and numbers speakers by first appearance without mutating input',()=>{
 expect(formatTranscript(segments,{timestamps:true,diarize:true})).toBe('[00:05] [SPEAKER_00]: Угу.\r\n[05:09] [SPEAKER_00]: Продолжение следует...\r\n[10:06] [SPEAKER_01]: Саша, я сейчас вернусь.\r\n[10:09] [SPEAKER_00]: Угу.\r\n');expect(segments[0].start).toBe(309);
});
it('uses HH:MM:SS from one hour and floors fractional seconds',()=>{expect(formatTime(3599.9)).toBe('59:59');expect(formatTime(3600)).toBe('01:00:00');expect(formatTime(3661)).toBe('01:01:01')});
it('does not invent speaker IDs and respects both switches',()=>{
 const data=[{start:0,end:1,text:' Да. \n Хорошо. '}];
 expect(formatTranscript(data,{timestamps:true,diarize:true})).toBe('[00:00] [SPEAKER_UNKNOWN]: Да. Хорошо.\r\n');
 expect(formatTranscript(data,{timestamps:false,diarize:false})).toBe('Да. Хорошо.\r\n');
 expect(formatTranscript(data,{timestamps:false,diarize:true})).toBe('[SPEAKER_UNKNOWN]: Да. Хорошо.\r\n');
 expect(formatTranscript(data,{timestamps:true,diarize:false})).toBe('[00:00] Да. Хорошо.\r\n');
});
it('rejects invalid timestamps and bounds',()=>{expect(()=>formatTime(-1)).toThrow();expect(()=>formatTime(Infinity)).toThrow();expect(()=>formatTranscript([{start:2,end:1,text:'x'}],{timestamps:true,diarize:true})).toThrow()});
it('exports UTF-8 BOM and Cyrillic without loss and a Windows-safe filename',async()=>{
 const blob=transcriptBlob('Привет\r\n');const bytes=new Uint8Array(await blob.arrayBuffer());expect([...bytes.slice(0,3)]).toEqual([239,187,191]);expect(new TextDecoder().decode(bytes)).toBe('Привет\r\n');expect(transcriptFilename('Запись: встречи.mp3')).toBe('Запись_ встречи_iscribe.txt');
});
