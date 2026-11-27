import {decodeAudio} from './audio';
import {decodeFfmpegAudio} from './ffmpegDecoder';
import {openFfmpegStreamedAudio} from './ffmpegStreamedAudio';
import {openStreamedAudio,type StreamedAudio} from './streamedAudio';

export type AudioDecoderKind='legacy'|'ffmpeg';
export interface AudioDecoderProvider{
 readonly kind:AudioDecoderKind;
 decode(file:File,signal?:AbortSignal):Promise<Float32Array>;
 openStream(file:File,signal?:AbortSignal):Promise<StreamedAudio>;
}
export const legacyAudioDecoder:AudioDecoderProvider={kind:'legacy',decode:decodeAudio,openStream:openStreamedAudio};
export const ffmpegAudioDecoder:AudioDecoderProvider={kind:'ffmpeg',decode:decodeFfmpegAudio,openStream:openFfmpegStreamedAudio};
export function chooseAudioDecoder(search:string):AudioDecoderProvider{
 return new URLSearchParams(search).get('decoder')==='ffmpeg'?ffmpegAudioDecoder:legacyAudioDecoder;
}
// Both routes are opt-in until the final acceptance stage.
export function decodeSelectedAudio(file:File,signal?:AbortSignal):Promise<Float32Array>{
 return chooseAudioDecoder(typeof location==='undefined'?'':location.search).decode(file,signal);
}

export function openSelectedStream(file:File,signal?:AbortSignal):Promise<StreamedAudio>{
 return chooseAudioDecoder(typeof location==='undefined'?'':location.search).openStream(file,signal);
}
