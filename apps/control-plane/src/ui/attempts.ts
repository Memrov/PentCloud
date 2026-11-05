import type { UIJob } from "./api";
export function threadAttempts(jobs: UIJob[], selected: UIJob): UIJob[] {
  const thread = selected.logicalThreadId ?? selected.id;
  return jobs.filter(j => (j.logicalThreadId ?? j.id) === thread).sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
}
export function threadTree(jobs: UIJob[]): UIJob[] {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const groups = new Map<string, UIJob[]>();
  for (const job of jobs) { const key = job.logicalThreadId ?? job.id; groups.set(key, [...(groups.get(key) ?? []), job]); }
  return [...groups.entries()].map(([id, attempts]) => {
    attempts.sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
    const first = attempts[0]!, latest = attempts.at(-1)!;
    const parent = first.parentJobId ? byId.get(first.parentJobId) : undefined;
    const { parentJobId: _parent, ...fields } = latest;
    return { ...fields, logicalThreadId: id, ...(parent ? { parentJobId: parent.logicalThreadId ?? parent.id } : {}) };
  });
}

export interface AgentConversation { id: string; label: string; task: string; job: UIJob; attempts: UIJob[] }
/** Presentation only: never combines messages from independent native sessions. */
export function conversations(jobs: readonly UIJob[]): AgentConversation[] {
  const groups = new Map<string, UIJob[]>();
  for (const job of jobs) {
    if (job.tool === "native_discovery") continue;
    const key = `${job.runId}:${job.logicalThreadId ?? job.id}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const ordered = [...groups.values()].map(attempts => {
    attempts.sort((a,b) => (a.attempt ?? 1) - (b.attempt ?? 1) || a.id.localeCompare(b.id));
    const first = attempts[0]!, job = attempts.at(-1)!;
    return {id: first.logicalThreadId ?? first.id, label: "", task: first.task ?? job.task ?? "", job, attempts};
  }).sort((a,b) => (a.attempts[0]!.conversationOrder ?? Number.MAX_SAFE_INTEGER) - (b.attempts[0]!.conversationOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  const counts = new Map<string,number>(), seen = new Map<string,number>();
  const key = (c:AgentConversation) => `${c.job.runId}:${c.job.role ?? "specialist"}`;
  for (const c of ordered) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  return ordered.map(c => {
    const role = c.job.role ?? "specialist", ordinal = (seen.get(key(c)) ?? 0) + 1;
    seen.set(key(c), ordinal);
    return {...c, label: role.charAt(0).toUpperCase() + role.slice(1) + ((counts.get(key(c)) ?? 0) > 1 ? ` ${ordinal}` : "")};
  });
}
export function preferredConversation(jobs: readonly UIJob[], selected?: string): UIJob | undefined {
  const existing = jobs.find(j => j.id === selected && j.tool !== "native_discovery");
  if (existing) return existing;
  const all = conversations(jobs).map(c => c.job);
  return all.find(j => j.status === "running") ?? all.find(j => j.preparingConversation) ?? all.findLast(j => j.role === "primary") ?? all[0];
}
