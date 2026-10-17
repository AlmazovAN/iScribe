import {expect,it} from 'vitest';
import {isModelId,MODELS} from '@yourdevice/engine';
it('registers the full Large v3 with a float encoder and q4 decoder',()=>{
 expect(isModelId('whisper-large-v3')).toBe(true);
 expect(MODELS['whisper-large-v3'].hfRepo).toBe('onnx-community/whisper-large-v3-ONNX');
 expect(MODELS['whisper-large-v3'].acceleratedDtype).toEqual({encoder_model:'fp16',decoder_model_merged:'q4'});
 expect(isModelId('whisper-large-v3-turbo')).toBe(false);
});
