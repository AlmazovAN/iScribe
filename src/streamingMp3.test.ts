import {afterEach,expect,it,vi} from 'vitest';
import {inspectMp3Frames,mp3FrameHeader,mp3Frames,Mp3WindowReader} from './streamingMp3';
const frameSize=417; // MPEG-1 layer III / 128 kbps / 44.1 kHz
function frame():Uint8Array{
 const data=new Uint8Array(frameSize);data.set([0xff,0xfb,0x90,0x64]);return data;
}
function file(frames:number,extra?:Uint8Array){
 const chunks:Uint8Array[]=[];
 if(extra)chunks.push(extra);
 for(let i=0;i<frames;i++)chunks.push(frame());
 return new Blob(chunks,{type:'audio/mpeg'});
}
afterEach(()=>vi.unstubAllGlobals());
it('parses MPEG-1 Layer III frame headers with frame-aligned 1152-sample accounting',()=>{
 expect(mp3FrameHeader(frame())).toEqual({byteLength:417,sampleRate:44100,channels:2,samples:1152});
 expect(mp3FrameHeader(Uint8Array.of(255,0,0,0))).toBeNull();
 expect(mp3FrameHeader(Uint8Array.of(255,251,0,100))).toBeNull();
});
it('streams ID3v2 and frame bytes from Blob slices without reading entire source',async()=>{
 const id3=new Uint8Array(17);id3.set([73,68,51,4,0,0,0,0,0,7]);
 const source=file(8,id3);
 const observed=[];
 for await(const part of mp3Frames(source)){observed.push(part.data.length)}
 expect(observed).toEqual(Array(8).fill(417));
 const scan=await inspectMp3Frames(source);
 expect(scan).toMatchObject({sampleRate:44100,channels:2,frames:8});
 expect(scan.pcmSamples).toBeGreaterThan(3000);
});
it('rejects broken frames, changes in sample rate, and clipped MPEG frames',async()=>{
 await expect(inspectMp3Frames(new Blob([Uint8Array.of(1,2,3)]))).rejects.toThrow('MP3');
 const bad=frame();bad[2]=0x94; // switch to 48 kHz
 await expect(inspectMp3Frames(new Blob([frame(),bad]))).rejects.toThrow('частоту');
 const incomplete=frame().slice(0,80);
 await expect(inspectMp3Frames(new Blob([incomplete]))).rejects.toThrow('посреди кадра');
});
it('rejects durations beyond the existing 60-minute window limit',async()=>{
 const head=frame();
 const size=417*144000;
 const blob={
  size,
  slice:(from:number,to:number)=>new Blob([new Uint8Array(Math.max(0,to-from)).map((_,i)=>head[(from+i)%417])])
 } as Blob;
 await expect(inspectMp3Frames(blob)).rejects.toThrow('до одного часа');
},30000);
it('uses a bounded decoder and retains identical 5-second PCM overlap between adjacent windows',async()=>{
 let receivedFrames=0,closed=0;
 class FakeDecoder{
  static async isConfigSupported(){return {supported:true}}
  constructor(private callbacks:{output:(f:unknown)=>void;error:(e:Error)=>void}){}
  configure(){}
  decode(){
   const value=(receivedFrames++%500)/500;
   this.callbacks.output({
    numberOfFrames:1152,numberOfChannels:2,sampleRate:44100,
    copyTo:(dest:Float32Array)=>{dest.fill(value)},
    close:()=>{}
   });
  }
  async flush(){}
  close(){closed++}
 }
 class Chunk{constructor(public init:unknown){}}
 vi.stubGlobal('AudioDecoder',FakeDecoder);
 vi.stubGlobal('EncodedAudioChunk',Chunk);
 const source=file(1450),overview=await inspectMp3Frames(source);
 expect(overview.duration).toBeGreaterThan(30);
 const decoder=await Mp3WindowReader.open(source,overview);
 const first=await decoder.window(0,480000);
 const second=await decoder.window(400000,Math.min(880000,overview.pcmSamples));
 expect(first).toHaveLength(480000);
 expect(second.length).toBeGreaterThan(80000);
 expect([...first.subarray(400000,400010)]).toEqual([...second.subarray(0,10)]);
 decoder.close();expect(closed).toBe(1);
});
it('reports unavailable browser codec instead of falling back to a full recording allocation',async()=>{
 vi.stubGlobal('AudioDecoder',undefined);
 vi.stubGlobal('EncodedAudioChunk',undefined);
 await expect(Mp3WindowReader.open(new Blob(),{pcmSamples:16000,channels:2,sampleRate:44100,frames:1,duration:1}))
  .rejects.toThrow('WebCodecs');
});
