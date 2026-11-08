import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  DashboardButton,
  reportReady
} from "../src/ui/components/dashboard-button";
import { runSteps } from "../src/ui/dashboard/run-steps";
import {
  connectWorkflowActivity,
  WorkflowTimelineView
} from "../src/ui/dashboard/workflow-timeline";
import { reduceWorkflowEvents } from "../src/ui/dashboard/model";
import type { UIJob } from "../src/ui/api";

const jobs: UIJob[] = [
  {
    id: "root",
    runId: "run-1",
    role: "primary",
    depth: 0,
    status: "running",
    revision: 2,
    task: "Inspect the target"
  },
  {
    id: "child",
    runId: "run-1",
    parentJobId: "root",
    role: "coder",
    depth: 1,
    status: "completed",
    revision: 4,
    archiveStatus: "complete",
    cleanupStatus: "stopped"
  }
];

describe("workflow dashboard components", () => {
  it("consumes native zero-based replay through a completed run into its live revision", () => {
    const listeners = new Map<string, EventListener>(),
      events: import("../src/ui/presentation").UIActivityEvent[] = [],
      states: string[] = [];
    let closed = 0,
      url = "";
    const stop = connectWorkflowActivity(
      "run-1",
      {
        event: (event) => events.push(event),
        connection: (state) => states.push(state)
      },
      (value) => {
        url = value;
        return {
          addEventListener: (name: string, listener: EventListener) =>
            listeners.set(name, listener),
          close: () => {
            closed++;
          }
        } as unknown as EventSource;
      }
    );
    const send = (id: number, type: string, instanceId = "run-1") =>
      listeners.get("message")!({
        data: JSON.stringify({
          instanceId,
          eventId: id,
          timestamp: id * 100,
          type
        }),
        lastEventId: String(id)
      } as MessageEvent);
    expect(url).toBe("/v1/ui/runs/run-1/workflow-events?protocol=2");
    send(0, "run.started");
    send(1, "run.completed");
    expect(closed).toBe(0);
    send(2, "run.started");
    listeners.get("up-to-date")!({} as Event);
    expect(states.at(-1)).toBe("live");
    expect(closed).toBe(0);
    expect(events[0]?.eventId).toBe(0);
    expect(reduceWorkflowEvents(events, 1000).status).toBe("running");
    send(3, "phase.started", "other-run");
    expect(events).toHaveLength(3);
    send(4, "run.completed");
    expect(closed).toBe(1);
    expect(states.at(-1)).toBe("closed");
    stop();
    expect(closed).toBe(2);
  });
  it("waits for a new replay tail when the same EventSource reconnects across completion and revision", () => {
    const listeners = new Map<string, EventListener>(),
      events: import("../src/ui/presentation").UIActivityEvent[] = [],
      states: string[] = [];
    let closed = 0;
    const source = {
      readyState: 1,
      addEventListener: (name: string, listener: EventListener) =>
        listeners.set(name, listener),
      close: () => {
        closed++;
      }
    } as unknown as EventSource;
    connectWorkflowActivity(
      "run-1",
      {
        event: (event) => events.push(event),
        connection: (state) => states.push(state)
      },
      () => source
    );
    const send = (id: number, type: string) =>
      listeners.get("message")!({
        data: JSON.stringify({
          instanceId: "run-1",
          eventId: id,
          timestamp: id * 100,
          type
        }),
        lastEventId: String(id)
      } as MessageEvent);
    source.onopen?.(new Event("open"));
    send(0, "run.started");
    listeners.get("up-to-date")!({} as Event);
    expect(states.at(-1)).toBe("live");
    source.onerror?.(new Event("error"));
    expect(states.at(-1)).toBe("reconnecting");
    source.onopen?.(new Event("open"));
    send(1, "run.completed");
    expect(closed).toBe(0);
    send(2, "run.started");
    expect(closed).toBe(0);
    expect(states.at(-1)).not.toBe("live");
    listeners.get("up-to-date")!({} as Event);
    expect(states.at(-1)).toBe("live");
    expect(closed).toBe(0);
    expect(reduceWorkflowEvents(events, 1000).status).toBe("running");
    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open"));
    send(3, "run.completed");
    expect(closed).toBe(0);
    listeners.get("up-to-date")!({} as Event);
    expect(closed).toBe(1);
    expect(states.at(-1)).toBe("closed");
  });
  it("closes completed history only after up-to-date, and closes empty history on native done", () => {
    const listeners = new Map<string, EventListener>();
    let closed = 0;
    connectWorkflowActivity(
      "run-1",
      { event: () => {}, connection: () => {} },
      () =>
        ({
          addEventListener: (name: string, listener: EventListener) =>
            listeners.set(name, listener),
          close: () => {
            closed++;
          }
        }) as unknown as EventSource
    );
    listeners.get("message")!({
      data: JSON.stringify({
        instanceId: "run-1",
        eventId: 0,
        timestamp: 0,
        type: "run.completed"
      }),
      lastEventId: "0"
    } as MessageEvent);
    expect(closed).toBe(0);
    listeners.get("up-to-date")!({} as Event);
    expect(closed).toBe(1);
    listeners.get("done")!({} as Event);
    expect(closed).toBe(2);
  });
  it("links report-ready only to accepted reporters for the selected run and target", () => {
    const reporter: UIJob = {
      id: "report",
      runId: "run-1",
      role: "reporter",
      status: "completed",
      revision: 1,
      outputCommit: "a".repeat(40)
    };
    expect(reportReady([reporter], "other-run")).toBe(false);
    expect(reportReady([{ ...reporter, status: "running" }], "run-1")).toBe(
      false
    );
    expect(
      reportReady([{ ...reporter, outputCommit: "unaccepted" }], "run-1")
    ).toBe(false);
    const html = renderToStaticMarkup(
      createElement(DashboardButton, {
        run: {
          id: "run-1",
          status: "completed",
          baselineRepo: "fixture",
          inputCommit: "a".repeat(40),
          maxDepth: 4,
          maxJobs: 32,
          target: {
            id: "target-1",
            kind: "website",
            name: "Fixture",
            url: "https://scope.invalid/",
            revision: 1
          }
        },
        jobs: [reporter]
      })
    );
    expect(html).toContain("Report ready");
    expect(html).toContain("view=findings");
    expect(html).toContain("target=target%3Atarget-1");
  });
  it("groups agents into launch-ordered steps with parallel agents on a shared role", () => {
    const run = (
      id: string,
      role: string,
      order: number,
      patch: Partial<UIJob> = {}
    ): UIJob => ({
      id,
      runId: "run-1",
      role,
      status: "completed",
      revision: 1,
      conversationOrder: order,
      ...patch
    });
    const steps = runSteps([
      run("report", "reporter", 5),
      run("s2", "searcher", 3),
      run("root", "primary", 1, { status: "waiting" }),
      run("s1", "searcher", 2),
      run("s1-retry", "searcher", 2, {
        logicalThreadId: "s1",
        attempt: 2,
        status: "running"
      }),
      run("code", "coder", 4)
    ]);
    expect(
      steps.map((step) => [
        step.role,
        step.agents.map((agent) => `${agent.label}:${agent.job.id}`)
      ])
    ).toEqual([
      ["primary", ["Primary:root"]],
      ["searcher", ["Searcher 1:s1-retry", "Searcher 2:s2"]],
      ["coder", ["Coder:code"]],
      ["reporter", ["Reporter:report"]]
    ]);
  });

  it("renders workflow duration bars, retries, errors, and chat navigation", () => {
    const timeline = reduceWorkflowEvents(
      [
        {
          instanceId: "child",
          eventId: 1,
          timestamp: 1_000,
          type: "run.started"
        },
        {
          instanceId: "child",
          eventId: 2,
          timestamp: 1_100,
          type: "phase.started",
          stepName: "run specialist"
        },
        {
          instanceId: "child",
          eventId: 3,
          timestamp: 1_400,
          type: "phase.failed",
          stepName: "run specialist",
          error: { name: "Error", message: "temporary" }
        }
      ],
      2_000
    );
    const html = renderToStaticMarkup(
      createElement(WorkflowTimelineView, {
        job: jobs[1]!,
        timeline,
        connection: "live"
      })
    );

    expect(html).toContain("Run activity");
    expect(html).toContain("Live events");
    expect(html).toContain("run specialist");
    expect(html).toContain("temporary");
    expect(html).toContain("/?run=run-1&amp;job=child");
  });
  it("shows a finished archive without retained phases instead of promising future events", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowTimelineView, {
        job: jobs[1]!,
        timeline: reduceWorkflowEvents([], 1_000),
        connection: "closed"
      })
    );
    expect(html).toContain("No retained activity history");
    expect(html).toContain("Its conversations are available in chat.");
    expect(html).not.toContain("Waiting for activity history");
    expect(html).not.toContain("workflow-empty-pulse");
  });
});
