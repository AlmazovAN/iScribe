// Speaker inference no longer needs PCM in the main thread once dispatched.
// Transfer avoids structured-cloning an entire decoded 1-hour Float32Array.
// If transfer is rejected while the buffer is still intact, clone instead.
export type SpeakerMessage={type:'iscribe:speakers';requestId:string;audio:Float32Array};
export function postSpeakerAudio(worker:Pick<Worker,'postMessage'>,message:SpeakerMessage):'transferred'|'cloned'{
 // Never transfer/clone unrelated backing data or detach another view's
 // owner when the caller provides a subarray. Copy only its visible samples.
 const original=message.audio;
 if(original.byteOffset!==0||original.byteLength!==original.buffer.byteLength)message={...message,audio:original.slice()};
 const buffer=message.audio.buffer;
 if(buffer instanceof ArrayBuffer){
  try{
   worker.postMessage(message,[buffer]);
   return 'transferred';
  }catch(error){
   // Never try to clone an already-detached buffer after an unexpected error.
   if(message.audio.byteLength===0)throw error;
  }
 }
 worker.postMessage(message);
 return 'cloned';
}
