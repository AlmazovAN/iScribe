import {expect,it} from 'vitest';
import {SpeakerPassMeter,emptySpeakerPerformance,speakerPerformanceReport} from './speakerPerformance';
it('reports observed milestones once without claiming individual inference durations',()=>{
 const meter=new SpeakerPassMeter(4,16000,100);
 meter.progress('Подготовка моделей говорящих',110);
 meter.progress('Поиск речи',140);meter.progress('Поиск речи',160);
 meter.progress('Разделение говорящих',180);meter.progress('Разделение говорящих',190);
 meter.finish(true,200);
 expect(meter.observation).toMatchObject({audioSeconds:1,preparationToFirstSpeechMs:40,firstSpeechToFirstSpeakerMs:40,firstSpeakerToEndMs:20,totalMs:100,status:'passed',progressEvents:5});
 const report=speakerPerformanceReport({...emptySpeakerPerformance(),passes:1,lastPass:meter.observation});
 expect(report?.lastPass?.threads.configured).toBeNull();
 expect(report?.lastPass?.requestedBackend).toBe('wasm');
});
it('keeps unavailable milestones null after a failed pass',()=>{
 const meter=new SpeakerPassMeter(1,16000,0);
 meter.finish(false,50);
 expect(meter.observation).toMatchObject({status:'failed',totalMs:50,preparationToFirstSpeechMs:null,firstSpeechToFirstSpeakerMs:null,firstSpeakerToEndMs:null});
});
