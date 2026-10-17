import type {TranscriptSegment} from '@yourdevice/engine';
export interface FormatOptions{timestamps:boolean;diarize:boolean}
export function formatTime(seconds:number):string{
 if(!Number.isFinite(seconds)||seconds<0)throw new Error('Некорректная временная метка.');
 const value=Math.floor(seconds),h=Math.floor(value/3600),m=Math.floor(value%3600/60),s=value%60;
 const pad=(n:number)=>String(n).padStart(2,'0');
 return h?`${pad(h)}:${pad(m)}:${pad(s)}`:`${pad(m)}:${pad(s)}`;
}
export function formatTranscript(segments:readonly TranscriptSegment[],options:FormatOptions):string{
 const speakers=new Map<string,string>();
 const sorted=[...segments].sort((a,b)=>a.start-b.start);
 const lines=sorted.map(segment=>{
  if(!Number.isFinite(segment.start)||segment.start<0||!Number.isFinite(segment.end)||segment.end<segment.start)throw new Error('Некорректные границы сегмента. Экспорт остановлен.');
  const text=segment.text.replace(/\s+/g,' ').trim();if(!text)return '';
  const prefix:string[]=[];
  if(options.timestamps)prefix.push(`[${formatTime(segment.start)}]`);
  if(options.diarize){
   const original=segment.speaker?.trim();let id='SPEAKER_UNKNOWN';
   if(original&&!/^(speaker[_ ]?)?unknown$/i.test(original)){
    let known=speakers.get(original);if(!known){known='SPEAKER_'+String(speakers.size).padStart(2,'0');speakers.set(original,known)}id=known;
   }
   prefix.push(`[${id}]:`);
  }
  return [...prefix,text].join(' ');
 }).filter(Boolean);
 return lines.length?lines.join('\r\n')+'\r\n':'';
}
export function transcriptBlob(text:string):Blob{return new Blob(['\ufeff',text],{type:'text/plain;charset=utf-8'})}
export function transcriptFilename(source:string):string{
 const base=source.replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*]/g,'_').split('').map(c=>c.charCodeAt(0)<32?'_':c).join('').replace(/[. ]+$/,'').slice(0,160)||'recording';
 return base+'_iscribe.txt';
}
export function downloadTranscript(text:string,source:string):void{
 if(!text.trim())throw new Error('Текст для скачивания отсутствует.');
 const url=URL.createObjectURL(transcriptBlob(text));const link=document.createElement('a');link.href=url;link.download=transcriptFilename(source);document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
