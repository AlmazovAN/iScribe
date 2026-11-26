import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {JobRow} from './JobRow';
import {DiagnosticsPanel} from './DiagnosticsPanel';
import type {Job} from './jobs';
import {createJob} from './jobs';
const diagnostics=(job:Job)=>renderToStaticMarkup(<DiagnosticsPanel job={job} jobs={[job]} busy={false} checking={false} onSelect={()=>{}} onInspect={()=>{}} onLog={()=>{}} onBenchmark={()=>{}} onHardware={async()=>{}}>{null}</DiagnosticsPanel>);
it('keeps both text exports enabled while speaker processing is running',()=>{
 const job={...createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:true}),stage:'speakers' as const,asrComplete:true,duration:60,nextWindow:3,percent:50,segments:[{start:0,end:1,text:'Готовый текст'}]};
 const html=renderToStaticMarkup(<JobRow job={job} active onStart={()=>{}} onExport={()=>{}} onTrash={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('≈ 00:30 / 01:00');
 expect(html).toContain('data-processing="true"');
 expect(html).toContain('>Скачать TXT</button>');expect(html).toContain('>TXT + time</button>');expect(html).toContain('<button disabled="">TXT + time + speaker');
 expect(html).not.toContain('<button disabled="">Скачать TXT');expect(html).not.toContain('<button disabled="">TXT + time</button>');
});

it('shows checkpoint data without claiming that pagehide proves a reload',()=>{
 const j=createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:false});
 const job={...j,stage:'interrupted' as const,failure:{reason:'session-ended' as const,at:1,stage:'recognizing' as const,message:'Previous session ended',backend:'webgpu',completedWindows:1,totalWindows:35,checkpointSeconds:30,durationSeconds:871,observedExit:'pagehide' as const}};
 const html=diagnostics(job);
 expect(html).toContain('сохранено окон: 1 / 35');
 expect(html).toContain('backend: webgpu');
 expect(html).toContain('не обязательно перезагрузка');
});

it('shows committed progress after interruption and flags transient unsaved text',()=>{
 const j=createJob(new File(['audio'],'long.mp3'),{model:'whisper-small',language:'ru',diarize:false});
 const html=renderToStaticMarkup(<JobRow job={{...j,duration:871,stage:'interrupted',nextWindow:2,segments:[{start:3,end:4,text:'saved'}],volatileSegments:[{start:3,end:4,text:'saved'},{start:55,end:56,text:'unsaved'}]}} active={false} onStart={()=>{}} onExport={()=>{}} onTrash={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('00:55 / 14:31');
 expect(html).toContain('2/35 (00:55 / 14:31)');
 expect(html).toContain('не сохранён в браузере');
});

it('shows a diagnostic JSON action after the first recorded event',()=>{
 const j=createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:false});
 const job={...j,trace:[{at:1,phase:'asr' as const,code:'window-start' as const,window:1}]};
 const html=diagnostics(job);
 expect(html).toContain('Скачать журнал JSON');
 expect(html).toContain('Подготовка окна');
 expect(html).toContain('Скачать журнал без аудио, текста и имени записи');
 expect(html).not.toContain('<button disabled="" title="Скачать журнал');
});


it('offers independent audio validation and shows the stored report in Diagnostics',()=>{
 const j=createJob(new File(['a'],'meeting.mp3'),{model:'whisper-small',language:'ru',diarize:false});
 const job={...j,audioCheck:{status:'passed' as const,checkedAt:100,report:{pcmSamples:960000,durationSeconds:60,windowCount:3,quietWindows:1,nearClippedWindows:0,peakAbsolute:0.7}}};
 const html=diagnostics(job);
 expect(html).toContain('Проверить аудио');
 expect(html).toContain('PCM проверен: 3 окон');

});
it('does not create an unsafe window plan when metadata claims more than one hour',()=>{
 const j=createJob(new File(['a'],'too-long.mp3'),{model:'whisper-small',language:'ru',diarize:false});
 const job={...j,duration:Infinity};
 const html=renderToStaticMarkup(<JobRow job={job} active={false} onStart={()=>{}} onExport={()=>{}} onTrash={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('Длительность уточняется');
});
