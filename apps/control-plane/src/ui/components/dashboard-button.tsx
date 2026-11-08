import { Badge, LinkButton } from "@cloudflare/kumo";
import { useId } from "react";
import type { UIJob, UIRun } from "../api";
import { dashboardHomePath } from "../dashboard/model";
import { targetKey } from "../findings-model";

/** Only an accepted reporter commit signals a ready report. No additional reads. */
export function reportReady(jobs: readonly UIJob[], runId?: string): boolean {
  return (
    !!runId &&
    jobs.some(
      (job) =>
        job.runId === runId &&
        job.role === "reporter" &&
        job.status === "completed" &&
        /^[a-f0-9]{40}$/.test(job.outputCommit ?? "")
    )
  );
}
export function DashboardButton({
  run,
  jobId,
  jobs,
  className,
  ariaLabel = "Dashboard"
}: {
  run?: UIRun | undefined;
  jobId?: string | undefined;
  jobs: readonly UIJob[];
  className?: string;
  ariaLabel?: string;
}) {
  const ready =
      !["trashed", "purging"].includes(run?.lifecycle ?? "active") &&
      reportReady(jobs, run?.id),
    id = useId();
  let href = dashboardHomePath(run?.id, jobId, run?.target?.id);
  if (ready && run) {
    const url = new URL(href, "https://pentcloud.invalid");
    url.searchParams.set("view", "findings");
    url.searchParams.set("target", targetKey(run));
    href = url.pathname + url.search;
  }
  return (
    <LinkButton
      variant="secondary"
      href={href}
      {...(className ? { className } : {})}
      aria-label={ariaLabel}
      aria-describedby={ready ? id : undefined}
    >
      Dashboard
      {ready && (
        <span id={id}>
          <Badge variant="success" className="text-base">
            Report ready
          </Badge>
        </span>
      )}
    </LinkButton>
  );
}
