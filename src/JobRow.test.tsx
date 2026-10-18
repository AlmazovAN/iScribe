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

it('shows committed progress after interruption and flags transient unsaved text',()=>{
 const j=createJob(new File(['audio'],'long.mp3'),{model:'whisper-small',language:'ru',diarize:false});
 const html=renderToStaticMarkup(<JobRow job={{...j,duration:871,stage:'interrupted',nextWindow:2,segments:[{start:3,end:4,text:'saved'}],volatileSegments:[{start:3,end:4,text:'saved'},{start:55,end:56,text:'unsaved'}]}} active={false} onStart={()=>{}} onExport={()=>{}} onCancel={()=>{}} onRemove={()=>{}} onPreview={()=>{}}/>);
 expect(html).toContain('00:55 / 14:31');
 expect(html).toContain('окон 2/35');
 expect(html).toContain('не сохранён в браузере');
});
