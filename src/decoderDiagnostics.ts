export type AudioDecoderKind='legacy'|'ffmpeg';
export type DecoderRoute='full'|'windowed';
export type DecoderIdentity={kind:AudioDecoderKind;route:DecoderRoute;revision:string};
export type FfmpegFailure='runtime'|'worker'|'timeout'|'decode'|'coverage'|'length'|'workerfs'|'probe'|'probe-exit'|'probe-json'|'probe-metadata'|'timeline'|'duration'|'window'|'protocol';
export type FfmpegStage='open'|'decode';
const messages:Record<FfmpegFailure,string>={
 runtime:'Ошибка запуска или обработки.',worker:'Ошибка Worker.',timeout:'Превышено время декодирования.',
 decode:'Не удалось декодировать аудиодорожку.',coverage:'Окно декодировано не полностью.',
 length:'Пустая запись или длительность более одного часа.',workerfs:'WORKERFS недоступна.',
 probe:'Не удалось определить параметры аудиодорожки.',
 'probe-exit':'FFprobe завершился с ошибкой.', 'probe-json':'FFprobe не сформировал корректный JSON.',
 'probe-metadata':'FFprobe не подтвердил параметры аудиодорожки.',timeline:'Начало аудиодорожки не совпадает с началом контейнера.',
 duration:'Не удалось подтвердить конец аудиозаписи.',window:'Некорректные границы окна.',
 protocol:'Нарушение последовательности запросов.'
};
export class FfmpegDecoderError extends Error{
 readonly code='ffmpeg-decoder-failed';
 constructor(readonly failure:FfmpegFailure,readonly stage:FfmpegStage,readonly exitCode?:number){
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
 return error instanceof FfmpegDecoderError?{decoderFailure:error.failure,decoderFailureStage:error.stage,decoderExitCode:safeExitCode(error.exitCode)}:{};
}
export function canRetryFfmpeg(error:unknown,route:DecoderRoute):boolean{
 if(!(error instanceof FfmpegDecoderError)||error.stage!=='decode')return false;
 return error.failure==='worker'||error.failure==='timeout'||(route==='windowed'&&error.failure==='coverage');
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
