export function reconcileFormRevision(local:{revision:number;dirty:boolean;initialized:boolean},incoming:number,force=false):"hydrate"|"keep"|"conflict" {
  if(force||!local.initialized)return "hydrate";
  if(local.revision===incoming)return "keep";
  return local.dirty?"conflict":"hydrate";
}
