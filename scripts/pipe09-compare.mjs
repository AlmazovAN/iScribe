// Local paired plain-TXT comparison. No network, no transcript or path in report.
import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const MAX_BYTES=2*1024*1024,MAX_WORDS=15000,MAX_CELLS=150000000;
export function normalizeWords(text){
 const words=text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
 if(words.length>MAX_WORDS)throw new Error('Word limit exceeded');
 return words;
}
export function compareWords(reference,candidate){
 if(!reference.length)throw new Error('Empty reference');
 if(reference.length>MAX_WORDS||candidate.length>MAX_WORDS||reference.length*candidate.length>MAX_CELLS)throw new Error('Comparison limit exceeded');
 let previous=new Uint32Array(candidate.length+1),current=new Uint32Array(candidate.length+1);
 for(let j=0;j<previous.length;j++)previous[j]=j;
 for(let i=1;i<=reference.length;i++){
  current[0]=i;
  for(let j=1;j<=candidate.length;j++)current[j]=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+Number(reference[i-1]!==candidate[j-1]));
  [previous,current]=[current,previous];
 }
 const edits=previous[candidate.length];
 return {referenceWords:reference.length,candidateWords:candidate.length,edits,wer:edits/reference.length};
}
async function readWords(path){
 const handle=await open(path,'r');
 try{
  const {size}=await handle.stat();
  if(size>MAX_BYTES)throw new Error('File limit exceeded');
  const bytes=Buffer.alloc(size+1);let bytesRead=0;
  while(bytesRead<bytes.length){const part=await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!part.bytesRead)break;bytesRead+=part.bytesRead}
  if(bytesRead!==size)throw new Error('File changed');
  return normalizeWords(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));
 }finally{await handle.close()}
}
export async function main(args){
 if(args.length<2||args.length>9)throw new Error('Supply reference and 1–8 plain TXT candidates');
 const reference=await readWords(args[0]),candidates=[];
 for(let i=1;i<args.length;i++)candidates.push({candidate:i,...compareWords(reference,await readWords(args[i]))});
 return {schema:'iscribe.pipe09.wer.v1',normalization:'NFKC lowercase Unicode letter/number words; plain TXT only',candidates};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await main(process.argv.slice(2)),null,2))}
 catch{console.error('PIPE-09 comparison failed. Supply readable UTF-8 plain TXT files within size/word/comparison limits and a nonempty reference.');process.exitCode=1}
}
