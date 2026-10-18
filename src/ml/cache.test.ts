import {expect,it} from 'vitest';
import {completeSet} from './cache';
it('does not treat partial weights or another model as a complete cached model',()=>{
 const repo='onnx-community/whisper-tiny';const prefix=`https://huggingface.co/${repo}/resolve/main/`;
 const paths=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json','onnx/encoder_model.onnx','onnx/decoder_model_merged_q4.onnx'].map(p=>prefix+p);
 expect(completeSet(paths,repo)).toBe(true);expect(completeSet(paths.slice(0,-1),repo)).toBe(false);expect(completeSet(paths,'onnx-community/whisper-small')).toBe(false);
});

it('rejects a mixed backend dtype and an unrelated revision despite having both ONNX kinds',()=>{
 const repo='onnx-community/whisper-small';const head='https://huggingface.co/'+repo+'/resolve/main/';
 const meta=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json'].map(x=>head+x);
 expect(completeSet([...meta,head+'onnx/encoder_model_quantized.onnx',head+'onnx/decoder_model_merged_q4.onnx'],repo)).toBe(false);
 expect(completeSet([...meta,head+'onnx/encoder_model_quantized.onnx',head.replace('/main/','/other/')+'onnx/decoder_model_merged_quantized.onnx'],repo)).toBe(false);
 expect(completeSet([...meta,head+'onnx/encoder_model_fp16.onnx',head+'onnx/decoder_model_merged_q4.onnx'],repo)).toBe(true);
});
