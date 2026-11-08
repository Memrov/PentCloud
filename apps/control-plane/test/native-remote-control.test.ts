import { describe, expect, it } from "vite-plus/test";
import {
  applyMetasploitInspection,
  authorizeMetasploitControl,
  metasploitOutcome,
  metasploitOwnershipState,
  type MetasploitOwnership
} from "../src/native/remote-control";

// Shapes taken from unchanged MetasploitMCP.py _execute_module_rpc,
// _execute_module_console, list_listeners and list_active_sessions.
const started = (extra: Record<string, unknown> = {}) =>
  metasploitOutcome(
    "metasploit_start_listener",
    {},
    {
      status: "warning",
      message: "No session detected within timeout.",
      job_id: 0,
      uuid: "execution-a",
      session_id: null,
      module: "exploit/multi/handler",
      options: { ExitOnSession: false },
      payload_name: "test-payload",
      payload_options: {},
      ...extra
    }
  )!;
const jobs = (
  handlers: Record<string, object> = {},
  other_jobs: Record<string, object> = {}
) => ({
  status: "success",
  handlers,
  other_jobs,
  handler_count: Object.keys(handlers).length,
  other_job_count: Object.keys(other_jobs).length,
  total_job_count: Object.keys(handlers).length + Object.keys(other_jobs).length
});
const sessions = (entries: Record<string, object> = {}) => ({
  status: "success",
  sessions: entries,
  count: Object.keys(entries).length
});

describe("stock Metasploit resource ownership", () => {
  it("retains a live listener even when its successful RPC returns warning and job zero", () => {
    const outcome = started();
    expect(outcome.state).toBe("running");
    expect(outcome.owned).toEqual({
      jobIds: ["0"],
      sessionIds: [],
      executionUuid: "execution-a",
      uncertain: false,
      needsSessionInspection: true
    });
    expect(
      authorizeMetasploitControl("metasploit_stop_job", { job_id: 0 }, [
        { id: "listener", owned: outcome.owned }
      ])
    ).toEqual({ receiptIds: ["listener"], kind: "job", resourceId: "0" });
  });

  it("does not release a handler and established session when only the job disappears", () => {
    const original = started({ status: "success", session_id: 7 }).owned;
    const stoppedJob = applyMetasploitInspection(
      original,
      "metasploit_list_listeners",
      jobs()
    );
    expect(stoppedJob.jobIds).toEqual([]);
    expect(stoppedJob.sessionIds).toEqual(["7"]);
    expect(metasploitOwnershipState(stoppedJob)).toBe("running");
    const active = applyMetasploitInspection(
      stoppedJob,
      "metasploit_list_active_sessions",
      sessions({ "7": { exploit_uuid: "execution-a" } })
    );
    expect(metasploitOwnershipState(active)).toBe("running");
    const ended = applyMetasploitInspection(
      active,
      "metasploit_list_active_sessions",
      sessions()
    );
    expect(metasploitOwnershipState(ended)).toBe("completed");
    expect(original.jobIds).toEqual(["0"]);
    expect(original.sessionIds).toEqual(["7"]);
  });

  it("requires a fresh session inventory after the last job stops and learns only matching execution UUIDs", () => {
    const beforeStop = applyMetasploitInspection(
      started().owned,
      "metasploit_list_active_sessions",
      sessions()
    );
    const stopped = applyMetasploitInspection(
      beforeStop,
      "metasploit_list_listeners",
      jobs()
    );
    expect(metasploitOwnershipState(stopped)).toBe("running");
    const discovered = applyMetasploitInspection(
      stopped,
      "metasploit_list_active_sessions",
      sessions({
        "3": { exploit_uuid: "execution-a" },
        "4": { exploit_uuid: "someone-else" }
      })
    );
    expect(discovered.sessionIds).toEqual(["3"]);
    expect(discovered.needsSessionInspection).toBe(false);
    expect(
      authorizeMetasploitControl(
        "metasploit_terminate_session",
        { session_id: 3 },
        [{ id: "listener", owned: discovered }]
      ).receiptIds
    ).toEqual(["listener"]);
    expect(() =>
      authorizeMetasploitControl(
        "metasploit_terminate_session",
        { session_id: 4 },
        [{ id: "listener", owned: discovered }]
      )
    ).toThrow("not owned");
  });

  it("captures synchronous console session_id_detected independently of async job IDs", () => {
    const result = metasploitOutcome(
      "metasploit_run_exploit",
      { run_as_job: false },
      {
        status: "success",
        session_id_detected: "8",
        module_output: "session opened",
        module: "exploit/test"
      }
    )!;
    expect(result.state).toBe("running");
    expect(result.owned.sessionIds).toEqual(["8"]);
    expect(result.owned.jobIds).toEqual([]);
    expect(
      metasploitOwnershipState(
        applyMetasploitInspection(
          result.owned,
          "metasploit_list_active_sessions",
          sessions()
        )
      )
    ).toBe("completed");
  });

  it("never clears unknown execution or missing correlation identity from empty inventories", () => {
    const unknown = metasploitOutcome(
      "metasploit_start_listener",
      {},
      {
        status: "unknown",
        message: "Exploit executed, but no job ID returned.",
        result: { uuid: "execution-a" },
        module: "exploit/multi/handler"
      }
    )!;
    expect(unknown.state).toBe("unknown");
    const after = applyMetasploitInspection(
      applyMetasploitInspection(
        unknown.owned,
        "metasploit_list_listeners",
        jobs()
      ),
      "metasploit_list_active_sessions",
      sessions()
    );
    expect(metasploitOwnershipState(after)).toBe("unknown");
    expect(() =>
      authorizeMetasploitControl("metasploit_stop_job", { job_id: 0 }, [
        { id: "unknown", owned: after }
      ])
    ).toThrow("not owned");
    const noUuid = started({ uuid: null });
    expect(noUuid.state).toBe("unknown");
    expect(
      authorizeMetasploitControl("metasploit_stop_job", { job_id: 0 }, [
        { id: "unknown-with-known-job", owned: noUuid.owned }
      ]).resourceId
    ).toBe("0");
  });

  it("keeps warning/error/unknown inventories from proving resource absence", () => {
    const owned = started({ session_id: 7 }).owned;
    for (const status of ["warning", "error", "unknown"]) {
      expect(
        applyMetasploitInspection(owned, "metasploit_list_listeners", {
          ...jobs(),
          status
        })
      ).toEqual(owned);
      expect(
        applyMetasploitInspection(owned, "metasploit_list_active_sessions", {
          ...sessions(),
          status
        })
      ).toEqual(owned);
    }
    expect(() =>
      applyMetasploitInspection(owned, "metasploit_list_active_sessions", {
        status: "success",
        sessions: {},
        count: 1
      })
    ).toThrow("Incomplete");
    expect(() =>
      applyMetasploitInspection(owned, "metasploit_list_listeners", {
        status: "success"
      })
    ).toThrow("Malformed");
  });

  it("allows only exact owned stop/terminate controls, never arbitrary session commands or cross-kind IDs", () => {
    const owned: MetasploitOwnership = {
      jobIds: ["0"],
      sessionIds: ["7"],
      executionUuid: "execution-a",
      uncertain: false,
      needsSessionInspection: true
    };
    const receipts = [{ id: "owned", owned }];
    expect(() =>
      authorizeMetasploitControl(
        "metasploit_send_session_command",
        { session_id: 7, command: "anything" },
        receipts
      )
    ).toThrow("Only owned");
    expect(() =>
      authorizeMetasploitControl(
        "metasploit_run_post_module",
        { session_id: 7 },
        receipts
      )
    ).toThrow("Only owned");
    expect(() =>
      authorizeMetasploitControl("metasploit_stop_job", { job_id: 7 }, receipts)
    ).toThrow("not owned");
    expect(() =>
      authorizeMetasploitControl(
        "metasploit_terminate_session",
        { session_id: 0 },
        receipts
      )
    ).toThrow("not owned");
    expect(() =>
      authorizeMetasploitControl(
        "metasploit_stop_job",
        { job_id: "0" },
        receipts
      )
    ).toThrow("integer");
    expect(() =>
      authorizeMetasploitControl(
        "metasploit_stop_job",
        { job_id: 0, session_id: 7 },
        receipts
      )
    ).toThrow("only");
  });

  it("distinguishes known pre-execution aborts from opaque launch errors and unrelated stock tools", () => {
    expect(
      metasploitOutcome(
        "metasploit_run_auxiliary_module",
        {},
        { status: "aborted", message: "Module not run." }
      )?.state
    ).toBe("completed");
    expect(
      metasploitOutcome(
        "metasploit_start_listener",
        {},
        { status: "error", message: "Unexpected server error running module." }
      )?.state
    ).toBe("unknown");
    expect(
      metasploitOutcome(
        "metasploit_run_exploit",
        {},
        { status: "success", session_id_detected: "invalid-session" }
      )?.state
    ).toBe("unknown");
    expect(
      metasploitOutcome("nmap_port_scan", {}, { status: "completed" })
    ).toBeUndefined();
    expect(
      metasploitOutcome("metasploit_list_active_sessions", {}, sessions())
    ).toBeUndefined();
  });
});
