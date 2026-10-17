import {expect,it} from 'vitest';
import {completeSet} from './cache';
it('does not treat partial weights or another model as a complete cached model',()=>{
 const repo='onnx-community/whisper-tiny';const prefix=`https://huggingface.co/${repo}/resolve/main/`;
 const paths=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json','onnx/encoder_model.onnx','onnx/decoder_model_merged_q4.onnx'].map(p=>prefix+p);
 expect(completeSet(paths,repo)).toBe(true);expect(completeSet(paths.slice(0,-1),repo)).toBe(false);expect(completeSet(paths,'onnx-community/whisper-small')).toBe(false);
});
