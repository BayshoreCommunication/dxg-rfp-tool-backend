import crypto from "node:crypto";
export const MOCK_EMBEDDING_DIMENSION=16;
export const deterministicEmbedding=(text:string)=>{
 const normalized=text.normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim(),hash=crypto.createHash("sha256").update(normalized).digest();
 const vector=Array.from({length:MOCK_EMBEDDING_DIMENSION},(_,i)=>(hash.readInt16BE(i*2)/32768));
 const magnitude=Math.sqrt(vector.reduce((sum,x)=>sum+x*x,0))||1;
 return vector.map(x=>Number((x/magnitude).toFixed(8)));
};
export const vectorLiteral=(values:number[])=>`[${values.join(",")}]`;
