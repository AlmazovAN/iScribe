import type {PrefetchPhase} from './adaptivePrefetch';
export type PerformanceMode='eco'|'medium'|'max';
export type ResourcePolicy={
 requested:PerformanceMode;effective:PerformanceMode;
 targetWasmThreads:number;targetPrefetchWindows:0|1|2;
 pauseRatio:number;maxPauseMs:number;
 prefetchAdaptation?:{phase:PrefetchPhase;readyStreak:number;missStreak:number};
 reasons:('prefetch-adaptive'|'recovery-cap'|'thread-prerequisites'|'memory-hint'|'cpu-hint')[];
};
export type ResourceObservations={
 version:1;windowCounts:Record<PerformanceMode,number>;
 requestedWindowCounts:Record<PerformanceMode,number>;
 lastPolicy:ResourcePolicy;pauseCount:number;pauseMs:number;
};
export function isPerformanceMode(value:unknown):value is PerformanceMode{
 return value==='eco'||value==='medium'||value==='max';
}
