import {decodeAudio} from './audio';
import {decodeFfmpegAudio,type FfmpegFrameRecovery} from './ffmpegDecoder';
import {openFfmpegStreamedAudio} from './ffmpegStreamedAudio';
import {openStreamedAudio,type StreamedAudio} from './streamedAudio';

import type {AudioDecoderKind} from './decoderDiagnostics';
export type {AudioDecoderKind} from './decoderDiagnostics';
export interface AudioDecoderProvider{
 readonly kind:AudioDecoderKind;
 decode(file:File,signal?:AbortSignal,recovery?:FfmpegFrameRecovery):Promise<Float32Array>;
 openStream(file:File,signal?:AbortSignal):Promise<StreamedAudio>;
}
export const legacyAudioDecoder:AudioDecoderProvider={kind:'legacy',decode:decodeAudio,openStream:openStreamedAudio};
export const ffmpegAudioDecoder:AudioDecoderProvider={kind:'ffmpeg',decode:decodeFfmpegAudio,openStream:openFfmpegStreamedAudio};
export function providerForDecoder(kind:AudioDecoderKind):AudioDecoderProvider{
 return kind==='ffmpeg'?ffmpegAudioDecoder:legacyAudioDecoder;
}
export function chooseAudioDecoder(search:string):AudioDecoderProvider{
 return providerForDecoder(new URLSearchParams(search).get('decoder')==='legacy'?'legacy':'ffmpeg');
}
// FFmpeg is the candidate default; legacy remains an explicit comparison/compatibility path.
export function decodeSelectedAudio(file:File,signal?:AbortSignal):Promise<Float32Array>{
 return chooseAudioDecoder(typeof location==='undefined'?'':location.search).decode(file,signal);
}

export function openSelectedStream(file:File,signal?:AbortSignal):Promise<StreamedAudio>{
 return chooseAudioDecoder(typeof location==='undefined'?'':location.search).openStream(file,signal);
}
