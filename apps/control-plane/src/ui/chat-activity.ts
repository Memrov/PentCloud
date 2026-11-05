import type {UIJob} from './api';
import type {ChatMessage} from './presentation';

export function isPublicationFence(error?:string){return error==='Attempt has settled'||error==='Terminal publication has started';}
export function toolLabel(name:string){
 const tool=name.split(/__|\./).at(-1)!.replace(/[_-]+/g,' ').trim();
 return `Using ${tool || 'tool'}`;
}
export function toolActivityLabel(name:string){
 const tool=name.split(/__|\./).at(-1)!;
 return ({cloudflare_browser:'Using the browser',web_search:'Searching the web',computer_read:'Reading a file',computer_write:'Writing a file',terminal:'Running a command',shell:'Running a command',computer_execute:'Running a command'} as Record<string,string>)[tool]??toolLabel(name);
}
export function chatActivity(job:UIJob,messages:readonly ChatMessage[],busy:boolean,connected:boolean):{label:string;working:boolean;detail:string}{
 const terminal:Record<string,string>={failed:'Failed',invalid_result:'Result needs attention',integration_failed:'Result could not be saved',interrupted:'Stopped',completed:'Completed',waiting:'Waiting for specialists'};
 if(terminal[job.status])return {label:terminal[job.status]!,working:false,detail:job.status==='waiting'?'This agent has handed work to specialists.':job.status==='completed'?'Result accepted and saved.':job.status==='interrupted'?'This attempt has stopped.':'Inspect the error below before retrying.'};
 if(job.preparingConversation)return {label:'Preparing assessment',working:busy,detail:'You can chat while initial discovery is running.'};
 if(job.status==='created')return {label:'Queued',working:false,detail:'This agent has not started. It will run after admitted work finishes.'};
 if(job.status==='provisioning')return {label:'Starting agent',working:true,detail:'Preparing the native session and tools.'};
 const parts=messages.flatMap(m=>m.parts);
 if(parts.some(p=>(p.type==='data-status'&&isPublicationFence(p.data.error))||(p.type==='dynamic-tool'&&p.state==='output-error'&&isPublicationFence(p.errorText))))return {label:'Updating agent status',working:true,detail:'The session has ended. Waiting for the run to accept or reconcile its result.'};
 const active=parts.findLast(p=>p.type==='dynamic-tool'&&p.state==='input-available');
 if(active?.type==='dynamic-tool')return {label:toolActivityLabel(active.toolName),working:true,detail:connected?'Live activity from this agent.':'Reconnecting to live updates; work may still be running.'};
 const latest=parts.findLast(p=>(p.type==='text'||p.type==='reasoning')&&p.text.length>0);
 if(busy&&latest&&(latest.type==='text'||latest.type==='reasoning')&&latest.state==='streaming')return {label:latest.type==='text'?'Writing':'Thinking',working:true,detail:connected?'Live output from this agent.':'Reconnecting to live updates; work may still be running.'};
 return {label:busy?'Working':connected?'Waiting for agent activity':'Reconnecting',working:busy,detail:connected?'Updates arrive automatically. You can steer this agent below.':'The connection is unavailable. This does not stop cloud execution.'};
}
