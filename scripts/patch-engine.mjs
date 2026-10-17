import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import process from 'node:process';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function patchedContent(source,spec){
 const checksum=hash(source);
 if(checksum===spec.patchedSha256)return source;
 if(checksum!==spec.sha256)throw new Error(`Engine patch refused: unexpected source for ${spec.file}`);
 let result=source;
 for(const change of spec.changes){
  if(result.split(change.find).length!==2)throw new Error(`Engine patch anchor mismatch: ${spec.file}`);
  result=result.replace(change.find,change.replace);
 }
 if(hash(result)!==spec.patchedSha256)throw new Error(`Engine patch checksum mismatch: ${spec.file}`);
 return result;
}
export function patchInstalledEngine(root=process.cwd()){
 const packageRoot=resolve(root,'node_modules/@yourdevice/engine');
 if(JSON.parse(readFileSync(resolve(packageRoot,'package.json'),'utf8')).version!=='0.1.1')throw new Error('Only engine 0.1.1 is supported by this patch.');
 const specs=JSON.parse(readFileSync(new URL('./engine-patches.json',import.meta.url),'utf8'));
 const changes=specs.map(spec=>({path:resolve(packageRoot,spec.file),text:patchedContent(readFileSync(resolve(packageRoot,spec.file),'utf8'),spec)}));
 for(const change of changes)writeFileSync(change.path,change.text);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))patchInstalledEngine();
