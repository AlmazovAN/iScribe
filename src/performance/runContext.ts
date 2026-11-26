import type {PerformanceMode} from './types';
declare const __ISCRIBE_BUILD_SHA__:string;
export type BenchmarkRunContext={
 buildRevision:string;launch:'standalone'|'web';mode:PerformanceMode;
 modelResidentAtStart:boolean;calibrationRequested:boolean;startCheckpoint:number;
};
export function captureRunContext(mode:PerformanceMode,modelResidentAtStart:boolean,calibrationRequested:boolean,startCheckpoint:number):BenchmarkRunContext{
 return {buildRevision:typeof __ISCRIBE_BUILD_SHA__==='string'&&/^[a-f0-9]{7,40}$/i.test(__ISCRIBE_BUILD_SHA__)?__ISCRIBE_BUILD_SHA__:'unavailable',
  launch:import.meta.env.MODE==='standalone'?'standalone':'web',mode,modelResidentAtStart,calibrationRequested,startCheckpoint};
}
export function runContextReport(context:BenchmarkRunContext|undefined){
 if(!context)return null;
 return {buildRevision:context.buildRevision,launch:context.launch,mode:context.mode,
  modelResidentAtStart:context.modelResidentAtStart,calibrationRequested:context.calibrationRequested,startCheckpoint:context.startCheckpoint};
}
