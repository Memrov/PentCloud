import {remoteResultObject} from "./tool-policy";
export function discoveryOutcome(raw:unknown):{success:boolean;status:string} {
  if(raw&&typeof raw==="object"&&"isError" in raw&&raw.isError)return {success:false,status:"tool-error"};
  try {
    const result=remoteResultObject(raw),status=String(result.status??"unknown").toLowerCase();
    const completed=["completed","complete","success","succeeded"].includes(status)&&result.error==null&&result.success!==false;
    const observed=typeof result.http_status==="number"&&Number.isInteger(result.http_status)&&result.http_status>=100&&result.http_status<=599;
    return {success:completed&&observed,status:completed&&!observed?"no-http-response":status};
  } catch {return {success:false,status:"invalid-result"};}
}
