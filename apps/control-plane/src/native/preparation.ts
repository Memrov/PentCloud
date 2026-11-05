import {canonical} from "./domain";
import type {AttemptInput} from "./types";

export const PREPARATION_INSTRUCTIONS="Preparation conversation: initial discovery may still be queued, starting or running. Discuss the customer's project, clarify goals and read supplied files. Only read-only preparation tools are available. Do not run scanners, execute code, write files, delegate or submit a role result. Do not poll or repeatedly retry unavailable actions. Give a useful reply or ask the customer a question, then yield. Assessment tools and validated discovery context arrive in this same session after execution admission.";
export function preparationTool(name:string):boolean {
  return ["computer_read","computer_ls","computer_find","computer_grep","pentcloud_progress","pentcloud_source_tree","pentcloud_source_read"].includes(name);
}
/** Preparation is not execution admission. Only source/context may advance once. */
export function assertPreparationPromotion(before:AttemptInput,after:AttemptInput):void {
  const identity=({inputCommit:_commit,context:_context,...rest}:AttemptInput)=>rest;
  if(before.role!=="primary"||before.parentJobId||before.execution||after.execution||
    canonical(identity(before))!==canonical(identity(after))||canonical(before.context.target)!==canonical(after.context.target))
    throw new Error("409: Preparation changed its frozen agent identity");
}
