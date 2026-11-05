import type { CSSProperties } from "react";

import { dashboardPath, jobActivityLabel, type RunGraphLayout } from "./model";

export function RunMap({ layout, selectedJobId }: { layout: RunGraphLayout; selectedJobId?: string }) {
  const byId = new Map(layout.nodes.map((node) => [node.job.id, node]));
  return (
    <section className="dashboard-map" aria-label="Specialist run map">
      <div className="dashboard-map-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="dashboard-map-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((edge) => {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) return null;
            const startY = source.y + 78;
            const endY = target.y;
            const middleY = startY + (endY - startY) / 2;
            return <path key={edge.id} d={`M ${source.x} ${startY} C ${source.x} ${middleY}, ${target.x} ${middleY}, ${target.x} ${endY}`} />;
          })}
        </svg>
        {layout.nodes.map(({ job, x, y }) => (
          <a
            key={job.id}
            href={dashboardPath(job.runId, job.id)}
            aria-current={selectedJobId === job.id ? true : undefined}
            className={`dashboard-job-node status-border-${job.status}`}
            style={{ left: x, top: y, "--node-depth": job.depth ?? 0 } as CSSProperties}
          >
            <span className="dashboard-node-heading">
              <span className="dashboard-node-avatar">{(job.role ?? job.tool ?? "S").slice(0, 1).toUpperCase()}</span>
              <span className="dashboard-node-copy">
                <strong>{job.role ?? job.tool ?? "specialist"}</strong>
                <small>{jobActivityLabel(job)}</small>
              </span>
              <span className={`status-dot status-${job.status}`} aria-label={job.status} />
            </span>
            <span className="dashboard-node-task">{job.task ?? job.id}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
