// Runs in the decoder worker only. Raw FFmpeg stderr is never transferred.
// Closed categories, not excerpts: no filename, metadata or audio content.
function createFfmpegErrorCollector(){
 const categories=new Set();
 let lines=0;
 function observe(event){
  if(event?.type!=='stderr'||typeof event.message!=='string'||!event.message.trim())return;
  lines=Math.min(10000,lines+1);
  const s=event.message.slice(0,4096);
  if(/protocol .*not on whitelist|protocol not found|unsafe file name/i.test(s))categories.add('input-protocol');
  else if(/decoder .*not found|unknown decoder|unsupported codec|decoding requested, but no decoder|codec .*not supported/i.test(s))categories.add('unsupported-codec');
  else if(/matches no streams|does not contain any stream|no audio stream/i.test(s))categories.add('missing-audio');
  else if(/cannot allocate memory|out of memory|allocation failed/i.test(s))categories.add('memory');
  else if(/unrecognized option|option .*not found|error parsing (global )?options|invalid argument.*option/i.test(s))categories.add('command-option');
  else if(/header missing|invalid frame|error (while )?decoding|error submitting (a )?packet|corrupt(ed)? (input )?(packet|frame)|invalid (audio|mpeg) header|overread|invalid huffman|invalid side information/i.test(s))categories.add('damaged-frame');
  else if(/invalid data found when processing input|could not find codec parameters|moov atom not found|failed to read frame size|end of file/i.test(s))categories.add('invalid-container');
  else if(/input[/]output error|permission denied|no such file or directory|error reading|error opening input|error writing/i.test(s))categories.add('io');
  else categories.add('other');
 }
 function snapshot(){return {details:[...categories].sort(),errorLines:lines}}
 return {observe,snapshot};
}
