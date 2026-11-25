// Large MP3-only path. No full compressed ArrayBuffer or full-recording PCM.
// MP3 frames are containerless WebCodecs EncodedAudioChunks (W3C registration).
import {MAX_SECONDS} from './audio';

export const STREAM_MP3_MIN_BYTES=128*1024*1024;
export const STREAM_MP3_MAX_BYTES=512*1024*1024;
const READ_BYTES=256*1024;
const CAPACITY=32*16000;
const M1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const M2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
export type Mp3FrameInfo={byteLength:number;sampleRate:number;channels:number;samples:number};
export type Mp3Frame=Mp3FrameInfo&{data:Uint8Array};
export type Mp3Overview={sampleRate:number;channels:number;frames:number;pcmSamples:number;duration:number};
export function mp3FrameHeader(bytes:Uint8Array,offset=0):Mp3FrameInfo|null{
 if(bytes.length-offset<4)return null;
 const a=bytes[offset],b=bytes[offset+1],c=bytes[offset+2],d=bytes[offset+3];
 if(a!==255||(b&0xe0)!==0xe0)return null;
 const version=(b>>3)&3,layer=(b>>1)&3,bitrate=(c>>4)&15,rateIndex=(c>>2)&3;
 if(version===1||layer!==1||bitrate===0||bitrate===15||rateIndex===3)return null;
 const base=[44100,48000,32000][rateIndex];
 const sampleRate=version===3?base:version===2?base/2:base/4;
 const kbps=(version===3?M1:M2)[bitrate];
 const samples=version===3?1152:576;
 const byteLength=Math.floor((version===3?144:72)*kbps*1000/sampleRate)+(c>>1&1);
 if(byteLength<24||byteLength>4096)return null;
 return {byteLength,sampleRate,channels:(d&0xc0)===0xc0?1:2,samples};
}
function synchsafe(tag:Uint8Array){
 if(tag.length<10||[tag[6],tag[7],tag[8],tag[9]].some(value=>value>127))
  throw new Error('Повреждён заголовок ID3 в MP3.');
 return (((tag[6]*128+tag[7])*128+tag[8])*128+tag[9]);
}
export async function* mp3Frames(file:Blob,signal?:AbortSignal):AsyncGenerator<Mp3Frame>{
 let bytes=new Uint8Array(0),cursor=0,loaded=0,absolute=0,headerChecked=false,frames=0;
 const fill=async(length:number)=>{
  while(bytes.length-cursor<length&&loaded<file.size){
   signal?.throwIfAborted();
   const next=new Uint8Array(await file.slice(loaded,Math.min(loaded+READ_BYTES,file.size)).arrayBuffer());
   const unread=bytes.subarray(cursor),joined=new Uint8Array(unread.length+next.length);
   joined.set(unread);joined.set(next,unread.length);
   bytes=joined;cursor=0;loaded+=next.length;
  }
  return bytes.length-cursor>=length;
 };
 const discard=(n:number)=>{cursor+=n;absolute+=n};
 if(!(await fill(10)))throw new Error('MP3 слишком короткий или повреждён.');
 if(String.fromCharCode(...bytes.subarray(0,3))==='ID3'){
  const size=synchsafe(bytes.subarray(0,10)) + 10 + ((bytes[5]&0x10)?10:0);
  if(size>16*1024*1024)throw new Error('Заголовок ID3 превышает 16 МБ.');
  // Do not ask fill() for a huge ID3 payload: skip via Blob offsets.
  bytes=new Uint8Array(0);cursor=0;absolute=size;loaded=size;
 }else headerChecked=true;
 let format:Pick<Mp3FrameInfo,'sampleRate'|'channels'>|undefined;
 while(await fill(4)){
  signal?.throwIfAborted();
  const tail=file.size-absolute;
  if(tail===128&&String.fromCharCode(...bytes.subarray(cursor,cursor+3))==='TAG')break;
  if(!headerChecked){headerChecked=true;if(!(await fill(4)))break}
  const info=mp3FrameHeader(bytes,cursor);
  if(!info){
   // Trailing ID3v1 and zero padding are permitted only at EOF.
   if(tail<=4096){
    await fill(Math.min(tail,4096));
    const remaining=bytes.subarray(cursor);
    const id3=remaining.length===128&&String.fromCharCode(...remaining.subarray(0,3))==='TAG';
    if(id3||remaining.every(value=>value===0))break;
   }
   throw new Error('Повреждён MP3: неверный заголовок кадра. Обработка остановлена до записи следующей контрольной точки.');
  }
  if(!format)format={sampleRate:info.sampleRate,channels:info.channels};
  else if(format.sampleRate!==info.sampleRate||format.channels!==info.channels)
   throw new Error('MP3 меняет частоту или число каналов. Потоковый декодер не может безопасно продолжать.');
  if(!(await fill(info.byteLength)))throw new Error('MP3 обрывается посреди кадра.');
  const data=bytes.slice(cursor,cursor+info.byteLength);
  discard(info.byteLength);frames++;
  yield {...info,data};
 }
 if(!frames)throw new Error('В MP3 не найдены аудиокадры.');
 // More than zero trailing data is always an error, except a valid ID3v1 tag.
 if(absolute<file.size&&file.size-absolute<4&&frames)throw new Error('Неполные последние байты MP3.');
}
export async function inspectMp3Frames(file:Blob,signal?:AbortSignal):Promise<Mp3Overview>{
 let pcmSamples=0,frames=0,sampleRate=0,channels=0;
 for await(const frame of mp3Frames(file,signal)){
  pcmSamples+=frame.samples;frames++;sampleRate=frame.sampleRate;channels=frame.channels;
  if(pcmSamples/sampleRate>MAX_SECONDS+0.1)throw new Error('В потоковом режиме пока поддерживаются записи до одного часа. Разделите более длинную запись.');
 }
 if(!Number.isSafeInteger(pcmSamples)||!sampleRate)throw new Error('Не удалось определить длительность MP3.');
 const samples=Math.floor((pcmSamples-1)*16000/sampleRate)+1;
 return {pcmSamples:samples,frames,sampleRate,channels,duration:pcmSamples/sampleRate};
}
type FrameData={numberOfFrames:number;numberOfChannels:number;sampleRate:number;copyTo:(destination:Float32Array,options:{planeIndex:number;format:'f32-planar'})=>void;close:()=>void};
type Decoder={configure:(config:{codec:string;sampleRate:number;numberOfChannels:number})=>void;decode:(chunk:unknown)=>void;flush:()=>Promise<void>;close:()=>void};
type DecoderCtor={new(init:{output:(data:FrameData)=>void;error:(error:Error)=>void}):Decoder;isConfigSupported:(config:{codec:string;sampleRate:number;numberOfChannels:number})=>Promise<{supported:boolean}>};
type ChunkCtor={new(init:{type:'key';timestamp:number;duration:number;data:Uint8Array}):unknown};
export function supportsMp3WebCodecs():boolean{
 const api=globalThis as unknown as {AudioDecoder?:DecoderCtor;EncodedAudioChunk?:ChunkCtor};
 return !!(api.AudioDecoder&&api.EncodedAudioChunk);
}
export class Mp3WindowReader{
 private readonly ring=new Float32Array(CAPACITY);
 private readonly frames:AsyncGenerator<Mp3Frame>;
 private readonly decoder:Decoder;
 private finished=false;
 private closed=false;
 private fault:Error|null=null;
 private frameTime=0;
 private inputPosition=0;
 private outputPosition=0;
 private previous=0;
 private bufferStart=0;
 private ready=0;
 private constructor(file:Blob,private readonly info:Mp3Overview,signal:AbortSignal|undefined,DecoderClass:DecoderCtor){
  this.frames=mp3Frames(file,signal);
  this.decoder=new DecoderClass({
   output:data=>{try{this.onDecoded(data)}catch(error){this.fault=error instanceof Error?error:new Error('Сбой PCM.')}finally{data.close()}},
   error:error=>{this.fault=error}
  });
  this.decoder.configure({codec:'mp3',sampleRate:info.sampleRate,numberOfChannels:info.channels});
 }
 static async open(file:Blob,info:Mp3Overview,signal?:AbortSignal):Promise<Mp3WindowReader>{
  const api=globalThis as unknown as {AudioDecoder?:DecoderCtor;EncodedAudioChunk?:ChunkCtor};
  if(!api.AudioDecoder||!api.EncodedAudioChunk)
   throw new Error('Для MP3 свыше 128 МБ браузер должен поддерживать WebCodecs AudioDecoder. Используйте актуальный Chrome, Edge или Opera.');
  const config={codec:'mp3',sampleRate:info.sampleRate,numberOfChannels:info.channels};
  const supported=await api.AudioDecoder.isConfigSupported(config);
  if(!supported.supported)throw new Error('Этот браузер не поддерживает потоковое декодирование MP3 через WebCodecs.');
  return new Mp3WindowReader(file,info,signal,api.AudioDecoder);
 }
 private append(value:number){
  if(!Number.isFinite(value))throw new Error('Декодер MP3 вернул NaN или Infinity. Контрольная точка не изменена.');
  if(this.ready-this.bufferStart>=CAPACITY)throw new Error('Превышен размер буфера потокового MP3.');
  this.ring[this.ready%CAPACITY]=value;this.ready++;
 }
 private onDecoded(data:FrameData){
  if(this.closed||this.fault)return;
  if(data.sampleRate!==this.info.sampleRate||data.numberOfChannels!==this.info.channels)
   throw new Error('Декодер MP3 изменил характеристики PCM.');
  const channels:Array<Float32Array>=[];
  for(let i=0;i<data.numberOfChannels;i++){
   const plane=new Float32Array(data.numberOfFrames);
   data.copyTo(plane,{planeIndex:i,format:'f32-planar'});channels.push(plane);
  }
  const rate=this.info.sampleRate;
  for(let pos=0;pos<data.numberOfFrames;pos++){
   let sample=0;
   for(const channel of channels)sample+=channel[pos]/channels.length;
   const n=this.inputPosition++;
   if(n===0){this.previous=sample;this.append(sample);this.outputPosition=1;continue}
   while(this.outputPosition*rate<=n*16000){
    const at=this.outputPosition*rate/16000,frac=at-(n-1);
    this.append(this.previous+(sample-this.previous)*frac);this.outputPosition++;
   }
   this.previous=sample;
  }
 }
 private async pump(signal?:AbortSignal){
  const chunkClass=(globalThis as unknown as {EncodedAudioChunk:ChunkCtor}).EncodedAudioChunk;
  let fed=0;
  for(;fed<24;fed++){
   signal?.throwIfAborted();
   const next=await this.frames.next();
   if(next.done){this.finished=true;break}
   const frame=next.value;
   const chunk=new chunkClass({type:'key',timestamp:Math.round(this.frameTime*1000000/this.info.sampleRate),
    duration:Math.round(frame.samples*1000000/this.info.sampleRate),data:frame.data});
   this.decoder.decode(chunk);
   this.frameTime+=frame.samples;
  }
  await this.decoder.flush();
  if(this.fault)throw this.fault;
 }
 // The caller must request windows in ascending order, retaining 5 s overlap.
 async window(start:number,end:number,signal?:AbortSignal):Promise<Float32Array>{
  if(this.closed||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||
    end-start>30*16000||start<this.bufferStart)
   throw new Error('Некорректное окно потокового MP3.');
  this.bufferStart=start;
  while(this.ready<end&&!this.finished){signal?.throwIfAborted();await this.pump(signal)}
  if(this.fault)throw this.fault;
  const available=Math.min(end,this.ready)-start;
  if(available<=0||end-this.ready>16000)
   throw new Error('MP3 декодирован не полностью. Расхождение длительности больше одной секунды.');
  const output=new Float32Array(available);
  for(let i=0;i<available;i++)output[i]=this.ring[(start+i)%CAPACITY];
  return output;
 }
 close(){if(this.closed)return;this.closed=true;this.decoder.close();void this.frames.return(undefined)}
}
