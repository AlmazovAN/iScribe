export type AudioDecoderKind='legacy'|'ffmpeg';
export type DecoderRoute='full'|'windowed';
export type DecoderIdentity={kind:AudioDecoderKind;route:DecoderRoute;revision:string};
export type FfmpegFailure='runtime'|'asset'|'initialize'|'worker'|'timeout'|'decode'|'coverage'|'length'|'workerfs'|'probe'|'probe-exit'|'probe-json'|'probe-metadata'|'timeline'|'duration'|'window'|'protocol'|'recovery-rejected';
export type FfmpegStage='open'|'decode';
const messages:Record<FfmpegFailure,string>={
 runtime:'Ошибка запуска или обработки.',asset:'Не удалось загрузить локальные ресурсы FFmpeg.',initialize:'Не удалось инициализировать FFmpeg WASM.',worker:'Ошибка Worker.',timeout:'Превышено время декодирования.',
 decode:'Не удалось декодировать аудиодорожку.',coverage:'Окно декодировано не полностью.',
 length:'Пустая запись или длительность более одного часа.',workerfs:'WORKERFS недоступна.',
 probe:'Не удалось определить параметры аудиодорожки.',
 'probe-exit':'FFprobe завершился с ошибкой.', 'probe-json':'FFprobe не сформировал корректный JSON.',
 'probe-metadata':'FFprobe не подтвердил параметры аудиодорожки.',timeline:'Начало аудиодорожки не совпадает с началом контейнера.',
 duration:'Не удалось подтвердить конец аудиозаписи.',window:'Некорректные границы окна.',
 protocol:'Нарушение последовательности запросов.',
 'recovery-rejected':'Восстановление аудиокадров не прошло контроль ошибок или длительности. PCM не передан в Whisper.'
};
const detailCodes=['input-protocol','unsupported-codec','missing-audio','memory','command-option','damaged-frame','invalid-container','io','other'] as const;
export type FfmpegDetailCode=typeof detailCodes[number];
export type FfmpegDetails={details:FfmpegDetailCode[];errorLines:number};
export function safeFfmpegDetails(raw:unknown,count:unknown):FfmpegDetails|undefined{
 if(!Array.isArray(raw)||typeof count!=='number'||!Number.isInteger(count)||count<0||count>10000)return undefined;
 const details=detailCodes.filter(code=>raw.includes(code));
 return {details:[...details],errorLines:count};
}
export class FfmpegDecoderError extends Error{
 readonly code='ffmpeg-decoder-failed';
 constructor(readonly failure:FfmpegFailure,readonly stage:FfmpegStage,readonly exitCode?:number,readonly diagnostic?:FfmpegDetails){
  super('FFmpeg: '+messages[failure]);this.name='FfmpegDecoderError';
 }
}
export function ffmpegFailure(raw:unknown):FfmpegFailure{
 return typeof raw==='string'&&Object.hasOwn(messages,raw)?raw as FfmpegFailure:'runtime';
}
export function safeExitCode(value:unknown):number|undefined{
 return typeof value==='number'&&Number.isInteger(value)&&value>=-255&&value<=255?value:undefined;
}
export function ffmpegFailureFields(error:unknown){
 return error instanceof FfmpegDecoderError?{decoderFailure:error.failure,decoderFailureStage:error.stage,decoderExitCode:safeExitCode(error.exitCode),...(error.diagnostic?{decoderDetails:error.diagnostic.details,decoderErrorLines:error.diagnostic.errorLines}:{})}:{};
}
export function canRetryFfmpeg(error:unknown,route:DecoderRoute):boolean{
 if(!(error instanceof FfmpegDecoderError)||error.stage!=='decode')return false;
 return error.failure==='worker'||error.failure==='timeout'||(route==='windowed'&&error.failure==='coverage');
}
// Allow one full-route recovery only before any committed ASR window.
export const MAX_FRAME_RECOVERY_ERROR_LINES=20;
export const MAX_FRAME_RECOVERY_DRIFT_SAMPLES=4000; // 250 ms at 16 kHz.
export function canRecoverFfmpegFrame(error:unknown):boolean{
 if(!(error instanceof FfmpegDecoderError)||error.failure!=='decode'||error.stage!=='decode'||!error.diagnostic)return false;
 const {details,errorLines}=error.diagnostic;
 return errorLines>0&&errorLines<=MAX_FRAME_RECOVERY_ERROR_LINES&&details.includes('damaged-frame')&&details.every(code=>code==='damaged-frame'||code==='other');
}
export function frameRecoveryExpectedSamples(seconds:number|undefined):number|undefined{
 if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0||seconds>3600)return undefined;
 const samples=Math.round(seconds*16000);
 return samples>0?samples:undefined;
}
export function validateFrameRecovery(expected:number,actual:number,diagnostic:FfmpegDetails|undefined):void{
 if(!Number.isSafeInteger(expected)||expected<1||expected>57600000||
    !Number.isSafeInteger(actual)||actual<1||actual>57600000||
    Math.abs(actual-expected)>MAX_FRAME_RECOVERY_DRIFT_SAMPLES||
    !diagnostic||diagnostic.errorLines>MAX_FRAME_RECOVERY_ERROR_LINES||
    diagnostic.details.some(code=>code!=='damaged-frame')||
    (diagnostic.errorLines>0&&!diagnostic.details.includes('damaged-frame')))
  throw new FfmpegDecoderError('recovery-rejected','decode',undefined,diagnostic);
}
export function decoderIdentity(kind:AudioDecoderKind,route:DecoderRoute):DecoderIdentity{
 return {kind,route,revision:kind==='ffmpeg'?'ffmpeg-core-0.12.10-dec02':'legacy-dec01'};
}
export function sameDecoder(a:DecoderIdentity,b:DecoderIdentity):boolean{
 return a.kind===b.kind&&a.route===b.route&&a.revision===b.revision;
}
export function resolveJobDecoder(existing:DecoderIdentity|undefined,hasCheckpoint:boolean,requested:AudioDecoderKind,route:DecoderRoute):DecoderIdentity{
 const current=decoderIdentity(existing?.kind??(hasCheckpoint?'legacy':requested),route);
 if(existing&&!sameDecoder(existing,current))
  throw new Error('Версия или маршрут декодера не совпадает с сохранённой записью. Добавьте аудио как новое задание.');
 return current;
}
export function decoderReport(identity:DecoderIdentity|undefined):DecoderIdentity|null{
 if(!identity||(identity.kind!=='legacy'&&identity.kind!=='ffmpeg')||
   (identity.route!=='full'&&identity.route!=='windowed'))return null;
 const known=decoderIdentity(identity.kind,identity.route);
 return sameDecoder(identity,known)?known:null;
}
