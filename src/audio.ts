export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_SECONDS = 3600;
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;
export function validateFile(file: Pick<File,'size'|'name'>): void {
  if(!/\.(wav|mp3|m4a|ogg|opus|webm|aac|flac)$/i.test(file.name)) throw new Error('Выберите аудиофайл WAV, MP3, M4A, OGG, Opus, WebM, AAC или FLAC.');
  if(file.size===0) throw new Error('Выбран пустой файл.');
  if(file.size>MAX_FILE_BYTES) throw new Error('Файл превышает ограничение 128 МБ. Разделите запись на части.');
}
export function mixMono(channels: readonly Float32Array[]): Float32Array<ArrayBuffer> {
  if(!channels.length || channels.some(c=>c.length!==channels[0].length)) throw new Error('Некорректные звуковые каналы.');
  const mono = new Float32Array(channels[0].length);
  for(const channel of channels) for(let i=0;i<mono.length;i++) mono[i]+=channel[i]/channels.length;
  return mono;
}
export async function decodeAudio(file: File, signal?: AbortSignal): Promise<Float32Array> {
  validateFile(file);signal?.throwIfAborted();
  const context=new AudioContext({sampleRate:16000});
  try {
    const bytes=await file.arrayBuffer();signal?.throwIfAborted();
    const decoded=await context.decodeAudioData(bytes);signal?.throwIfAborted();
    if(!Number.isFinite(decoded.duration)||decoded.duration<=0) throw new Error('В записи нет аудиоданных.');
    if(decoded.duration>MAX_SECONDS) throw new Error('Для этого выпуска ограничение — один час. Разделите запись на части.');
    if(decoded.length*decoded.numberOfChannels*4>MAX_DECODED_BYTES) throw new Error('Для декодирования нужно слишком много памяти. Разделите запись.');
    // Reuse the decoder's mono buffer during resampling, rather than making
    // another full-length Float32Array copy. Mixed stereo has its own buffer.
    const mono=decoded.numberOfChannels===1?decoded.getChannelData(0):mixMono(Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i)));
    if(decoded.sampleRate===16000)return decoded.numberOfChannels===1?mono.slice():mono;
    const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);
    const buffer=offline.createBuffer(1,mono.length,decoded.sampleRate);buffer.copyToChannel(mono,0);
    const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
    const rendered=await offline.startRendering();signal?.throwIfAborted();
    // The rendered AudioBuffer owns this stable channel view. Returning it
    // avoids another complete copy of a long recording in peak RAM.
    return rendered.getChannelData(0);
  } catch(error) {
    if(error instanceof DOMException && error.name==='EncodingError') throw new Error('Браузер не смог декодировать запись. Попробуйте WAV или MP3.');
    throw error;
  } finally {await context.close();}
}
