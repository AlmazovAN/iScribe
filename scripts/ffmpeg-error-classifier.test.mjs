import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {expect,it} from 'vitest';
const source=readFileSync(new URL('../src/ffmpegErrorClassifier.js',import.meta.url),'utf8');
it('classifies fixed FFmpeg failure categories without exporting raw lines',()=>{
 const collector=runInContext(source+'\ncreateFfmpegErrorCollector()',createContext({}));
 for(const message of ['[mp3] Header missing','Decoder (codec mp3) not found','Invalid data found when processing input','Protocol https not on whitelist','Cannot allocate memory','Output file does not contain any stream','Unrecognized option x','Error reading /source/input','PRIVATE SECRET'])collector.observe({type:'stderr',message});
 collector.observe({type:'stdout',message:'ignore'});
 const result=collector.snapshot();
 expect(result.errorLines).toBe(9);
 expect(result.details).toEqual(['command-option','damaged-frame','input-protocol','invalid-container','io','memory','missing-audio','other','unsupported-codec']);
 expect(JSON.stringify(result)).not.toContain('PRIVATE');
 expect(JSON.stringify(result)).not.toContain('/source/input');
});
it('bounds counts and ignores empty/non-stderr messages',()=>{
 const collector=runInContext(source+'\ncreateFfmpegErrorCollector()',createContext({}));
 collector.observe({type:'stderr',message:''});
 for(let i=0;i<10002;i++)collector.observe({type:'stderr',message:'Unknown error'});
 expect(collector.snapshot()).toEqual({details:['other'],errorLines:10000});
});
