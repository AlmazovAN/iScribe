import {createRoot} from 'react-dom/client';
import {App} from '../../src/App';
import {JobRunner} from '../../src/jobRunner';
import {FixtureManager,fixtureDecode} from './mockRuntime';
import type {ModelManager} from '../../src/ml/manager';
// This HTML entry is deliberately not referenced by production index.html.
// Playwright runs the real React UI, IndexedDB, Cache API and TXT downloads;
// only Whisper/diarization and expensive audio decoding are deterministic fakes.
createRoot(document.getElementById('root')!).render(
 <App createRunner={()=>new JobRunner({manager:new FixtureManager() as unknown as ModelManager,decode:fixtureDecode})}/>
);
