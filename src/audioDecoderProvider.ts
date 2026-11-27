import {decodeAudio} from './audio';
import {decodeFfmpegAudio} from './ffmpegDecoder';

export type AudioDecoderKind='legacy'|'ffmpeg';
export interface AudioDecoderProvider{
 readonly kind:AudioDecoderKind;
 decode(file:File,signal?:AbortSignal):Promise<Float32Array>;
}
export const legacyAudioDecoder:AudioDecoderProvider={kind:'legacy',decode:decodeAudio};
export const ffmpegAudioDecoder:AudioDecoderProvider={kind:'ffmpeg',decode:decodeFfmpegAudio};
export function chooseAudioDecoder(search:string):AudioDecoderProvider{
 return new URLSearchParams(search).get('decoder')==='ffmpeg'?ffmpegAudioDecoder:legacyAudioDecoder;
}
// Stage 01 is opt-in. The streamed route is deliberately unchanged.
export function decodeSelectedAudio(file:File,signal?:AbortSignal):Promise<Float32Array>{
 return chooseAudioDecoder(typeof location==='undefined'?'':location.search).decode(file,signal);
}
