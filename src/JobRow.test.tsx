import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {JobRow} from './JobRow';
import {DiagnosticsPanel} from './DiagnosticsPanel';
import type {Job} from './jobs';
import {createJob} from './jobs';
const diagnostics=(job:Job)=>renderToStaticMarkup(<DiagnosticsPanel job={job} jobs={[job]} onSelect={()=>{}} onLog={()=>{}}/>);
it('keeps both text exports enabled while speaker processing is running',()=>{
 const job={...createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:true}),stage:'speakers' as const,asrComplete:true,duration:60,nextWindow:3,percent:50,segments:[{start:0,end:1,text:'Готовый текст'}]};
 const html=renderToStaticMarkup(<JobRow job={job} active onStart={()=>{}} onExport={()=>{}} onTrash={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('≈ 00:30 / 01:00');
 expect(html).toContain('data-processing="true"');
 expect(html).toContain('>Скачать TXT</button>');expect(html).toContain('>TXT + time</button>');expect(html).toContain('<button disabled="">TXT + time + speaker');
 expect(html).not.toContain('<button disabled="">Скачать TXT');expect(html).not.toContain('<button disabled="">TXT + time</button>');
});

it('shows committed progress after interruption and flags transient unsaved text',()=>{
 const j=createJob(new File(['audio'],'long.mp3'),{model:'whisper-small',language:'ru',diarize:false});
 const html=renderToStaticMarkup(<JobRow job={{...j,duration:871,stage:'interrupted',nextWindow:2,segments:[{start:3,end:4,text:'saved'}],volatileSegments:[{start:3,end:4,text:'saved'},{start:55,end:56,text:'unsaved'}]}} active={false} onStart={()=>{}} onExport={()=>{}} onTrash={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('00:55 / 14:31');
 expect(html).toContain('2/35 (00:55 / 14:31)');
 expect(html).toContain('не сохранён в браузере');
});

it('shows only one compact diagnostics action and the current window',()=>{
 const j=createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:false});
 const html=diagnostics({...j,stage:'recognizing',duration:738,nextWindow:1});
 expect(html).toContain('Логирование JSON');expect(html).toContain('Номер окна: 2 из 30');
 expect(html).not.toContain('<details');expect(html).not.toContain('Проверить аудио');
 expect(html.match(/<button/g)).toHaveLength(1);
});

it('does not create an unsafe window plan when metadata claims more than one hour',()=>{
 const j=createJob(new File(['a'],'too-long.mp3'),{model:'whisper-small',language:'ru',diarize:false});
 const job={...j,duration:Infinity};
 const html=renderToStaticMarkup(<JobRow job={job} active={false} onStart={()=>{}} onExport={()=>{}} onTrash={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('Длительность уточняется');
});
