import type {ChatMessage} from './presentation';

export interface ChatTurn {id:string;role:'user'|'assistant'|'system';messages:ChatMessage[]}

/** Presentation only: model/tool steps share one response until the next operator message. */
export function chatTurns(messages:readonly ChatMessage[],job?:{id:string;task?:string|undefined}):ChatTurn[]{
 const turns:ChatTurn[]=[];let objectiveShown=false;
 const controlIds=job?new Set([`msg_${job.id}`,`msg_prepare-${job.id}`,`msg_finalize-${job.id}`]):new Set<string>();
 for(const original of messages){
  let message=original;
  if(original.role==='user'&&controlIds.has(original.id)){
   if(!objectiveShown&&job?.task){turns.push({id:`objective:${job.id}`,role:'user',messages:[{id:`objective:${job.id}`,role:'user',parts:[{type:'text',text:job.task,state:'done'}]}]});objectiveShown=true;}
   message={...original,role:'system'};
  }
  const previous=turns.at(-1);
  if(message.role!=='user'&&previous&&previous.role!=='user'){
   previous.messages.push(message);
   if(message.role==='assistant')previous.role='assistant';
  }else turns.push({id:message.id,role:message.role,messages:[message]});
 }
 return turns;
}
