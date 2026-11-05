import type {UIRun} from "./api";

export function runName(run:UIRun):string {
  return run.target?.name || run.target?.url || "Assessment";
}
/** Historical archives may not carry a creation time. Never infer it from an ID. */
export function runDate(run:UIRun):string {
  return run.createdAt !== undefined
    ? new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(run.createdAt)
    : run.id.replace(/^run-/, "").slice(0,8);
}
export function runLabel(run:UIRun):string {return `${runName(run)} · ${runDate(run)}`;}
