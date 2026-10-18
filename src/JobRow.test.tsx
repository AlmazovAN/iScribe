import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {JobRow} from './JobRow';
import {createJob} from './jobs';
it('keeps both text exports enabled while speaker processing is running',()=>{
 const job={...createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:true}),stage:'speakers' as const,asrComplete:true,segments:[{start:0,end:1,text:'Готовый текст'}]};
 const html=renderToStaticMarkup(<JobRow job={job} active onStart={()=>{}} onExport={()=>{}} onCancel={()=>{}} onRemove={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('>Скачать TXT</button>');expect(html).toContain('>TXT + time</button>');expect(html).toContain('<button disabled="">TXT + time + speaker');
 expect(html).not.toContain('<button disabled="">Скачать TXT');expect(html).not.toContain('<button disabled="">TXT + time</button>');
});

it('shows checkpoint data without claiming that pagehide proves a reload',()=>{
 const j=createJob(new File(['a'],'meeting.wav'),{model:'whisper-small',language:'ru',diarize:false});
 const job={...j,stage:'interrupted' as const,failure:{reason:'session-ended' as const,at:1,stage:'recognizing' as const,message:'Previous session ended',backend:'webgpu',completedWindows:1,totalWindows:35,checkpointSeconds:30,durationSeconds:871,observedExit:'pagehide' as const}};
 const html=renderToStaticMarkup(<JobRow job={job} active={false} onStart={()=>{}} onExport={()=>{}} onCancel={()=>{}} onRemove={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('сохранено окон: 1 / 35');
 expect(html).toContain('backend: webgpu');
 expect(html).toContain('не обязательно перезагрузка');
});
