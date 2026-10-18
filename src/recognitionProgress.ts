import {formatTime} from './formatTranscript';

// Whisper is fed 16 kHz PCM. Progress is based on successfully committed
// whole windows, never on the 0–30 s callback from an individual inference.
const SAMPLE_RATE=16000;
export type AudioWindow={start:number;end:number;first:boolean;last:boolean};
export type CheckpointProgress={completedWindows:number;totalWindows:number;seconds:number;totalSeconds:number;percent:number};
export function checkpointProgress(windows:readonly AudioWindow[],nextWindow:number):CheckpointProgress{
 if(!Number.isInteger(nextWindow)||nextWindow<0||nextWindow>windows.length)throw new Error('Некорректная контрольная точка распознавания.');
 const totalSeconds=windows.length?windows[windows.length-1].end/SAMPLE_RATE:0;
 const seconds=nextWindow?windows[nextWindow-1].end/SAMPLE_RATE:0;
 return {completedWindows:nextWindow,totalWindows:windows.length,seconds,totalSeconds,percent:totalSeconds?Math.min(100,seconds/totalSeconds*100):0};
}
export function checkpointLabel(p:CheckpointProgress):string {
 return `Сохранено: ${formatTime(p.seconds)} / ${formatTime(p.totalSeconds)} · окон ${p.completedWindows}/${p.totalWindows}`;
}
export function currentWindowLabel(windows:readonly AudioWindow[],index:number):string {
 const p=checkpointProgress(windows,index);
 if(index>=windows.length)throw new Error('Окно распознавания отсутствует.');
 return `Распознавание · окно ${index+1}/${windows.length} · ${checkpointLabel(p)}`;
}
