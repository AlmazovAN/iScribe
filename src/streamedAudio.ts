import {ADTS,AudioSampleSink,BlobSource,FLAC,Input,MP3,MP4,OGG,QTFF,WAVE,WEBM} from 'mediabunny';
import {inspectDecodedPcm,PCM_SAMPLE_RATE,type AudioInspectionReport} from './audioValidation';
import {audioWindows} from './jobs';
import type {AudioWindow} from './recognitionProgress';

import type {TraceEvent} from './jobTrace';

export type StreamReadEvent=Pick<TraceEvent,'elapsedMs'|'packets'|'decodedFrames'|'sourceSampleRate'|'pcmSamples'|'streamStage'>&{
 code:'stream-samples'|'stream-read-end'|'stream-resample-start'|'stream-resample-end';
};
export type StreamReadObserver=(event:StreamReadEvent)=>void|Promise<void>;
let nextDecoderId=0;
export const allocateStreamDecoderId=()=>++nextDecoderId;
const formats=[MP3,WAVE,MP4,QTFF,OGG,WEBM,ADTS,FLAC];

export async function openStreamedAudio(file:File,signal?:AbortSignal){
 signal?.throwIfAborted();
 const decoderId=allocateStreamDecoderId();
 let input:Input|null=new Input({source:new BlobSource(file),formats});
 let sink:AudioSampleSink|null=null;
 let closed=false,reading=false;
 const close=()=>{
  if(closed)return;
  closed=true;
  signal?.removeEventListener('abort',close);
  // Drop our references even when native disposal throws. A pending read
  // still owns its local buffers until the browser actually settles it.
  const owned=input;input=null;sink=null;
  owned?.dispose();
 };
 signal?.addEventListener('abort',close,{once:true});
 try{
  const track=await input.getPrimaryAudioTrack();
  if(!track||!await track.canDecode())
   throw new Error('Браузер не поддерживает потоковое декодирование аудиодорожки этого файла.');
  const [origin,end,rate]=await Promise.all([track.getFirstTimestamp(),track.computeDuration(),track.getSampleRate()]);
  signal?.throwIfAborted();
  const length=Math.round((end-origin)*PCM_SAMPLE_RATE);
  if(!Number.isSafeInteger(length)||length<=0||Math.ceil(length/(25*PCM_SAMPLE_RATE))>file.size||
     !Number.isInteger(rate)||rate<8000||rate>384000)
   throw new Error('Некорректные параметры аудиодорожки.');
  sink=new AudioSampleSink(track);

  async function read(window:AudioWindow,observe?:StreamReadObserver,onProgress?:()=>void,strictCoverage=false):Promise<Float32Array>{
   if(closed||!sink)throw new Error('Потоковый декодер закрыт. Продолжите с сохранённого окна.');
   if(reading)throw new Error('Параллельное чтение потокового декодера запрещено.');
   signal?.throwIfAborted();
   reading=true;
   try{
   // Decode a little before the boundary to warm up the decoder and resampler.
   const start=Math.max(0,window.start-PCM_SAMPLE_RATE);
   const startTime=origin+start/PCM_SAMPLE_RATE;
   const endTime=origin+window.end/PCM_SAMPLE_RATE;
   const sourceLength=Math.ceil((window.end-start)*rate/PCM_SAMPLE_RATE);
   // Mix directly into the AudioBuffer used by OfflineAudioContext. At
   // native 16 kHz retain the original independent Float32Array path.
   const sourceBuffer=rate===PCM_SAMPLE_RATE?undefined:new AudioBuffer({length:sourceLength,numberOfChannels:1,sampleRate:rate});
   const mono=sourceBuffer?sourceBuffer.getChannelData(0):new Float32Array(sourceLength);
   let covered=false,packets=0,decodedFrames=0,furthestFrame=0;
   // Reuse one per-read channel scratch buffer instead of allocating a
   // new Float32Array backing buffer for every decoded sample.
   let scratch=new Float32Array(0);
   let lastYield=performance.now();
   const readStarted=performance.now();let lastSampleTrace=readStarted;
   const checkOpen=()=>{signal?.throwIfAborted();if(closed)throw new Error('Потоковый декодер закрыт.');};
   const stats=()=>({packets,decodedFrames,sourceSampleRate:rate,elapsedMs:performance.now()-readStarted});
   for await(const sample of sink.samples(startTime,endTime)){
    // Yield even if a codec produces duplicate or out-of-range samples in
    // a tight microtask loop. The watchdog and cancellation need a task turn.
    try{
     if(performance.now()-lastYield>=25){
      await new Promise<void>(resolve=>setTimeout(resolve,0));lastYield=performance.now();
     }
     checkOpen();packets++;decodedFrames+=sample.numberOfFrames;
     if(sample.sampleRate!==rate||!Number.isFinite(sample.timestamp)||sample.numberOfChannels<1)
      throw new Error('Аудиодорожка меняет формат внутри записи.');
     const offset=Math.round((sample.timestamp-startTime)*rate);
     const first=Math.max(0,-offset,strictCoverage?furthestFrame-offset:0);
     const last=Math.min(sample.numberOfFrames,mono.length-offset);
     if(last<=first)continue;
     // Recovery subwindows must not silently synthesize missing audio.
     // Allow gaps in decoder warm-up, but reject uncovered requested frames.
     if(strictCoverage&&offset+first>Math.max(furthestFrame,Math.floor((window.start-start)*rate/PCM_SAMPLE_RATE)))
      throw new Error('Неполное покрытие аудиоданных в резервном фрагменте.');
     covered=true;
     if(scratch.length<last-first)scratch=new Float32Array(last-first);
     const plane=scratch.subarray(0,last-first);
     for(let channel=0;channel<sample.numberOfChannels;channel++){
      sample.copyTo(plane,{format:'f32-planar',planeIndex:channel,frameOffset:first,frameCount:last-first});
      for(let i=0;i<plane.length;i++)mono[offset+first+i]+=plane[i]/sample.numberOfChannels;
     }
     // Only newly covered audio positions count as progress. Duplicate,
     // out-of-range and empty packets cannot keep a stuck iterator alive.
     const reached=offset+last;
     if(reached>furthestFrame){furthestFrame=reached;onProgress?.();}
    }finally{sample.close()}
    if(observe&&performance.now()-lastSampleTrace>=5000){
     lastSampleTrace=performance.now();await observe({code:'stream-samples',streamStage:'decode',...stats()});checkOpen();
    }
   }
   checkOpen();
   if(observe){await observe({code:'stream-read-end',streamStage:'decode',...stats()});checkOpen();}
   if(!covered)throw new Error('Декодер не вернул данные для текущего окна.');
   if(strictCoverage&&furthestFrame<mono.length)throw new Error('Резервный фрагмент декодирован не полностью.');
   const outputLength=window.end-start;
   if(rate===PCM_SAMPLE_RATE)return mono.subarray(window.start-start,outputLength);
   const resampleStarted=performance.now();
   if(observe){await observe({code:'stream-resample-start',streamStage:'resample',sourceSampleRate:rate});checkOpen();}
   const context=new OfflineAudioContext(1,outputLength,PCM_SAMPLE_RATE);
   const node=context.createBufferSource();
   try{
    node.buffer=sourceBuffer!;node.connect(context.destination);node.start();
    const result=await context.startRendering();
    checkOpen();
    const pcm=result.getChannelData(0).subarray(window.start-start,outputLength);
    if(observe){await observe({code:'stream-resample-end',streamStage:'resample',elapsedMs:performance.now()-resampleStarted,pcmSamples:pcm.length,sourceSampleRate:rate});checkOpen();}
    return pcm;
   }finally{node.disconnect()}
   }finally{reading=false}
  }
  return {length,read,close,decoderId};
 }catch(error){close();throw error}
}

export type StreamedAudio=Awaited<ReturnType<typeof openStreamedAudio>>;

export async function inspectStreamedAudio(audio:StreamedAudio,signal?:AbortSignal,onProgress?:(done:number,total:number)=>void,readChecked?:(window:AudioWindow,index:number,total:number)=>Promise<AudioInspectionReport>):Promise<AudioInspectionReport>{
 const windows=audioWindows(audio.length,true);
 const report:AudioInspectionReport={
  pcmSamples:audio.length,durationSeconds:audio.length/PCM_SAMPLE_RATE,windowCount:windows.length,
  quietWindows:0,nearClippedWindows:0,peakAbsolute:0
 };
 for(const [index,window] of windows.entries()){
  signal?.throwIfAborted();
  const check=readChecked?await readChecked(window,index,windows.length):await inspectDecodedPcm(await audio.read(window),{signal});
  report.quietWindows+=check.quietWindows;
  report.nearClippedWindows+=check.nearClippedWindows;
  report.peakAbsolute=Math.max(report.peakAbsolute,check.peakAbsolute);
  onProgress?.(index+1,windows.length);
 }
 return report;
}
