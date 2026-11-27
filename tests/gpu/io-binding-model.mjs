// Small, self-contained ONNX graph for the GPU-05 lab. No model download.
// ONNX protobuf fields: ModelProto(ir_version=1, graph=7, opset_import=8),
// GraphProto(node=1, name=2, input=11, output=12), ValueInfoProto(name=1,type=2).
const concat=(...parts)=>Uint8Array.from(parts.flatMap(p=>Array.from(p)));
function varint(value){
 if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Invalid protobuf integer');
 const bytes=[];
 while(value>=128){bytes.push(value%128+128);value=Math.floor(value/128)}
 bytes.push(value);return Uint8Array.from(bytes);
}
const int=(field,value)=>concat(varint(field*8),varint(value));
const message=(field,data)=>concat(varint(field*8+2),varint(data.length),data);
const str=(field,value)=>message(field,new TextEncoder().encode(value));
export const MIB=1024*1024;
export const MAX_BYTES=16*MIB;
export const STEPS=8;
export function validateSize(bytes){
 if(![MIB,4*MIB,16*MIB].includes(bytes))throw new RangeError('Unsupported tensor size');
 return bytes/4;
}
export function createAddModel(bytes){
 const count=validateSize(bytes);
 const shape=message(1,int(1,count));
 const type=message(1,concat(int(1,1),message(2,shape)));
 const valueInfo=name=>concat(str(1,name),message(2,type));
 const node=concat(str(1,'X'),str(1,'X'),str(2,'Y'),str(4,'Add'));
 const graph=concat(message(1,node),str(2,'iscribe-gpu05'),message(11,valueInfo('X')),message(12,valueInfo('Y')));
 return concat(int(1,8),message(7,graph),message(8,int(2,13)));
}
export function inputValues(bytes){
 const result=new Float32Array(validateSize(bytes));
 for(let i=0;i<result.length;i++)result[i]=(i%257)/256;
 return result;
}
export function validateOutput(data,bytes){
 const count=validateSize(bytes);
 if(!(data instanceof Float32Array)||data.length!==count)return false;
 for(let i=0;i<count;i++)if(data[i]!==((i%257)/256)*2**STEPS)return false;
 return true;
}
export function plannedTraffic(bytes,mode){
 validateSize(bytes);
 if(!['cpu','gpu','fixed'].includes(mode))throw new RangeError('Unsupported mode');
 const transfers=mode==='cpu'?STEPS:1;
 return {uploadBytes:bytes*transfers,downloadBytes:bytes*transfers,totalBytes:2*bytes*transfers};
}
export function median(samples){
 if(!samples.length||samples.some(v=>!Number.isFinite(v)||v<0))return null;
 const s=[...samples].sort((a,b)=>a-b),mid=Math.floor(s.length/2);
 return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;
}
