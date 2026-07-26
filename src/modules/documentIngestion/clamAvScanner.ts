import net from "node:net";
import type { MalwareScanner, ScanResult } from "./ports";

const frame = (chunk: Buffer) => { const length=Buffer.alloc(4); length.writeUInt32BE(chunk.length); return Buffer.concat([length,chunk]); };
const clamScan = (bytes: Buffer): Promise<ScanResult> => new Promise((resolve) => {
  const host=process.env.CLAMAV_HOST || "127.0.0.1"; const port=Number(process.env.CLAMAV_PORT || 3310); const timeout=Number(process.env.CLAMAV_TIMEOUT_MS || 15000);
  const socket=net.createConnection({host,port}); let reply=""; let settled=false;
  const done=(result:ScanResult)=>{ if(settled)return; settled=true; socket.destroy(); resolve(result); };
  socket.setTimeout(timeout,()=>done({status:"unavailable",scanner:"clamav",diagnosticCode:"SCAN_TIMEOUT"}));
  socket.on("error",()=>done({status:"unavailable",scanner:"clamav",diagnosticCode:"SCANNER_UNAVAILABLE"}));
  socket.on("data",chunk=>{reply+=chunk.toString("utf8");});
  socket.on("close",()=>{
    if(settled)return;
    if(reply.includes(" FOUND")) done({status:"infected",scanner:"clamav",diagnosticCode:"MALWARE_DETECTED"});
    else if(reply.includes(" OK")) done({status:"clean",scanner:"clamav"});
    else done({status:"error",scanner:"clamav",diagnosticCode:"INVALID_SCANNER_RESPONSE"});
  });
  socket.on("connect",()=>{ socket.write("zINSTREAM\0"); for(let offset=0;offset<bytes.length;offset+=64*1024) socket.write(frame(bytes.subarray(offset,offset+64*1024))); socket.end(Buffer.alloc(4)); });
});

const testScanner: MalwareScanner = { async scan(bytes) {
  const infected=bytes.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
  return infected ? {status:"infected",scanner:"test-signature",diagnosticCode:"MALWARE_DETECTED"} : {status:"clean",scanner:"test-signature"};
} };

export const configuredMalwareScanner = (): MalwareScanner => {
  if (process.env.DOCUMENT_SCANNER_MODE === "test-signature" && process.env.NODE_ENV === "test") return testScanner;
  return { scan: clamScan };
};

