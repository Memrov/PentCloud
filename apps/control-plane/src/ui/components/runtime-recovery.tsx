import { Banner, Button } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import {
  getRuntimeDiagnostics,
  rearmRuntimeRecovery,
  type UIPlatformRecovery,
  type UIRuntimeDiagnostics
} from "../api";

export function RuntimeRecoveryNotice({
  recovery,
  scope,
  attemptId,
  onResumed
}: {
  recovery: UIPlatformRecovery;
  scope: "coordinator" | "attempt";
  attemptId?: string;
  onResumed?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [resumed, setResumed] = useState(false);
  const resume = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await rearmRuntimeRecovery({
        scope,
        observedAt: recovery.observedAt,
        ...(attemptId ? { attemptId } : {})
      });
      setResumed(true);
      await onResumed?.();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not resume recovery"
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2" role="status">
      <Banner
        variant="alert"
        title={`${scope === "coordinator" ? "Coordinator" : "Attempt"}${recovery.sealed ? " recovery paused after memory resets" : " memory reset recorded"}`}
        description="Scanner ownership remains reserved while outcomes are unresolved."
        action={
          recovery.sealed ? (
            <Button
              variant="secondary"
              disabled={busy || resumed}
              onClick={() => void resume()}
            >
              {resumed
                ? "Recovery resumed"
                : busy
                  ? "Resuming…"
                  : "Resume recovery"}
            </Button>
          ) : undefined
        }
      />
      {error && <Banner variant="error" role="alert" description={error} />}
    </div>
  );
}

/** A thin view of the existing Coordinator authority, with explicit operator recovery. */
export function RuntimeRecoveryPanel() {
  const [snapshot, setSnapshot] = useState<UIRuntimeDiagnostics>(),
    [error, setError] = useState<string>(),
    [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    try {
      setSnapshot(await getRuntimeDiagnostics());
      setError(undefined);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not read runtime diagnostics"
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let live = true;
    void getRuntimeDiagnostics()
      .then((value) => {
        if (live) setSnapshot(value);
      })
      .catch((caught) => {
        if (live)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not read runtime diagnostics"
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section
      className="native-controls grid gap-3 text-base"
      aria-label="Runtime recovery"
    >
      <div className="settings-heading-actions">
        <strong>Runtime status</strong>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Refresh status
        </Button>
      </div>
      {snapshot && (
        <p>
          {snapshot.backlog.waiting} waiting ·{" "}
          {snapshot.active
            ? `Active attempt: ${snapshot.active.id}`
            : "No active attempt"}
          {snapshot.coordinator.version
            ? ` · Version ${snapshot.coordinator.version.id}`
            : ""}
        </p>
      )}
      {snapshot?.active?.unresolvedRemote ? (
        <p>
          {snapshot.active.unresolvedRemote} scanner outcome(s) require
          reconciliation before recovery can resume.
        </p>
      ) : null}
      {snapshot?.coordinator.recovery && (
        <RuntimeRecoveryNotice
          key={`coordinator-${snapshot.coordinator.recovery.observedAt}`}
          recovery={snapshot.coordinator.recovery}
          scope="coordinator"
          onResumed={refresh}
        />
      )}
      {snapshot?.active?.recovery && (
        <RuntimeRecoveryNotice
          key={`attempt-${snapshot.active.recovery.observedAt}`}
          recovery={snapshot.active.recovery}
          scope="attempt"
          attemptId={snapshot.active.id}
          onResumed={refresh}
        />
      )}
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
