import type {PerformanceMode} from './types';
export const DEFAULT_PERFORMANCE_MODE:PerformanceMode='medium';
export const performanceLabels:Record<PerformanceMode,string>={eco:'Экономичная',medium:'Средняя',max:'Максимальная'};
export const profiles={
 eco:{pauseRatio:0.15,maxPauseMs:1000,prefetch:0},
 medium:{pauseRatio:0.03,maxPauseMs:100,prefetch:1},
 max:{pauseRatio:0,maxPauseMs:0,prefetch:2}
} as const;
