export const STREAM_AUDIO_BYTES = 128 * 1024 * 1024;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const usesStreamedAudio=(size:number)=>size>STREAM_AUDIO_BYTES;
export const MAX_SECONDS = 3600;
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;
export function validateFile(file: Pick<File,'size'|'name'>): void {
  if(!/\.(wav|mp3|m4a|ogg|opus|webm|aac|flac)$/i.test(file.name)) throw new Error('Выберите аудиофайл WAV, MP3, M4A, OGG, Opus, WebM, AAC или FLAC.');
  if(file.size===0) throw new Error('Выбран пустой файл.');
  if(file.size>MAX_FILE_BYTES) throw new Error('Файл превышает ограничение 500 МБ. Разделите запись на части.');
}
export function mixMonoInto(channels:readonly Float32Array[],mono:Float32Array):void{
  if(!channels.length||channels.some(c=>c.length!==mono.length||c.buffer===mono.buffer))throw new Error('Некорректные звуковые каналы.');
  mono.fill(0);
  for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/channels.length;
}
export function mixMono(channels: readonly Float32Array[]): Float32Array<ArrayBuffer> {
  if(!channels.length)throw new Error('Некорректные звуковые каналы.');
  const mono=new Float32Array(channels[0].length);mixMonoInto(channels,mono);return mono;
}
export async function decodeAudio(file: File, signal?: AbortSignal): Promise<Float32Array> {
  validateFile(file);signal?.throwIfAborted();
  if(usesStreamedAudio(file.size))throw new Error('Для этого файла требуется потоковое декодирование.');
  const context=new AudioContext({sampleRate:16000});
  try {
    const bytes=await file.arrayBuffer();signal?.throwIfAborted();
    const decoded=await context.decodeAudioData(bytes);signal?.throwIfAborted();
    if(!Number.isFinite(decoded.duration)||decoded.duration<=0||!Number.isSafeInteger(decoded.length)||decoded.length<=0||!Number.isSafeInteger(decoded.numberOfChannels)||decoded.numberOfChannels<1||!Number.isFinite(decoded.sampleRate)||decoded.sampleRate<=0)
      throw new Error('Декодер вернул некорректные параметры аудио. Проверьте файл.');
    if(decoded.duration>MAX_SECONDS) throw new Error('Для этого выпуска ограничение — один час. Разделите запись на части.');
    if(decoded.length*decoded.numberOfChannels*4>MAX_DECODED_BYTES) throw new Error('Для декодирования нужно слишком много памяти. Разделите запись.');
    const channels=()=>Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i));
    if(decoded.sampleRate===16000)return decoded.numberOfChannels===1?decoded.getChannelData(0):mixMono(channels());
    const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);
    // A mono AudioBuffer can be used directly by the offline source. For
    // multichannel input, mix into the resampler's buffer without a second
    // full-length mono allocation. The resampling algorithm is unchanged.
    const buffer=decoded.numberOfChannels===1?decoded:offline.createBuffer(1,decoded.length,decoded.sampleRate);
    if(decoded.numberOfChannels!==1)mixMonoInto(channels(),buffer.getChannelData(0));
    const source=offline.createBufferSource();
    try{
      source.buffer=buffer;source.connect(offline.destination);source.start();
      const rendered=await offline.startRendering();signal?.throwIfAborted();
      return rendered.getChannelData(0);
    }finally{source.disconnect()}
  } catch(error) {
    if(error instanceof DOMException && error.name==='EncodingError') throw new Error('Браузер не смог декодировать запись. Попробуйте WAV или MP3.');
    throw error;
  } finally {await context.close();}
}
