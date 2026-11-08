import { Flow } from "@cloudflare/kumo";

import type { UIJob } from "../api";
import { conversations, type AgentConversation } from "../attempts";
import { dashboardPath, jobActivityLabel } from "./model";

export interface RunStep { role: string; agents: AgentConversation[] }

/** Steps follow launch order; agents sharing a role run on the same step. */
export function runSteps(jobs: readonly UIJob[]): RunStep[] {
  const steps: RunStep[] = [];
  for (const agent of conversations(jobs)) {
    const role = agent.job.role ?? "specialist";
    const step = steps.find(candidate => candidate.role === role);
    if (step) step.agents.push(agent); else steps.push({ role, agents: [agent] });
  }
  return steps;
}

/** Vertical run pipeline built on Kumo's Flow; parallel agents branch side by side. */
export function RunSteps({ jobs, selectedJobId }: { jobs: readonly UIJob[]; selectedJobId?: string }) {
  return (
    <section className="run-steps" aria-label="Run steps">
      <Flow orientation="vertical" align="center">
        {runSteps(jobs).map(step => step.agents.length === 1
          ? <AgentNode key={step.role} agent={step.agents[0]!} selectedJobId={selectedJobId} />
          : <Flow.Parallel key={step.role}>{step.agents.map(agent => <AgentNode key={agent.id} agent={agent} selectedJobId={selectedJobId} />)}</Flow.Parallel>)}
      </Flow>
    </section>
  );
}

function AgentNode({ agent, selectedJobId }: { agent: AgentConversation; selectedJobId?: string | undefined }) {
  const { job } = agent;
  const selected = agent.attempts.some(attempt => attempt.id === selectedJobId);
  return (
    <Flow.Node id={agent.id} render={
      <a className="run-step-node" href={dashboardPath(job.runId, job.id)} aria-current={selected ? true : undefined}>
        <span className="dashboard-node-heading">
          <span className="dashboard-node-avatar">{agent.label.slice(0, 1)}</span>
          <span className="dashboard-node-copy"><strong>{agent.label}</strong><small>{jobActivityLabel(job)}</small></span>
          <span className={`status-dot status-${job.status}`} aria-label={job.status} />
        </span>
        {agent.task && <span className="dashboard-node-task">{agent.task}</span>}
      </a>
    } />
  );
}
