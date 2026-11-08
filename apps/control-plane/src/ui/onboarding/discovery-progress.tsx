import { Banner, Button, Loader } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { UIJob } from "../api";

export function DiscoveryProgress({
  jobs,
  settled,
  failed,
  refreshing,
  onRefresh,
  children,
  inChat = false
}: {
  jobs: UIJob[];
  settled: boolean;
  failed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  children?: ReactNode;
  inChat?: boolean;
}) {
  const queued =
    jobs.some((job) => ["created", "provisioning"].includes(job.status)) &&
    !jobs.some((job) => job.status === "running");
  const finishing =
    jobs.length > 0 &&
    jobs.every((job) => job.status === "completed") &&
    !settled;
  const title = failed
    ? "Discovery needs attention"
    : settled
      ? "Discovery complete"
      : queued
        ? "Waiting for discovery to start"
        : finishing
          ? "Finishing discovery"
          : "Preparing discovery and checking your target";
  const description = failed
    ? "Discovery could not finish normally. Review the coverage gap below. Analysis stays locked until scanner work is safely settled."
    : settled
      ? inChat
        ? "The initial check is finished. Assessment continues in this conversation when admitted."
        : "The initial check is finished. Complete setup to open your chat."
      : queued
        ? "Your target is confirmed. Discovery will start automatically."
        : finishing
          ? "Saving the discovery result and waiting for scanner work to settle."
          : "The tools for this run are preparing automatically. The initial check will begin when they are ready.";
  return (
    <section
      className="onboarding-card onboarding-progress"
      aria-label="Discovery progress"
    >
      <div className="onboarding-row">
        <h2>Initial discovery</h2>
        <Button variant="ghost" disabled={refreshing} onClick={onRefresh}>
          Refresh progress
        </Button>
      </div>
      <Banner
        className="onboarding-discovery-banner"
        variant={failed ? "alert" : "default"}
        aria-live="polite"
        aria-atomic="true"
        icon={
          <span className="onboarding-discovery-icon">
            {failed ? (
              <WarningCircleIcon size={16} />
            ) : settled ? (
              <CheckCircleIcon size={16} />
            ) : (
              <Loader size="sm" aria-label="Discovery in progress" />
            )}
          </span>
        }
        title={title}
        description={description}
      />
      {!settled && (
        <p>
          {inChat
            ? "Chat and supplied file reads are available while discovery runs. Assessment tools wait for scanner work to settle."
            : "Choose and test your models and API access, then open chat while discovery continues."}
        </p>
      )}
      <p>
        Basic fingerprinting uses no model. A failed or protected response does
        not mean the target is safe.
      </p>
      {children}
    </section>
  );
}
