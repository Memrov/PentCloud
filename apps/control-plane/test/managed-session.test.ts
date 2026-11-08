import { expect, it } from "vite-plus/test";
import {
  ManagedSession,
  type ManagedSessionAPI
} from "../src/native/managed-session";

function fixture() {
  let active = true;
  const replies: unknown[] = [];
  const forms: Awaited<
    ReturnType<ManagedSessionAPI["sessions"]["form"]["list"]>
  > = [
    {
      id: "frm_question",
      sessionID: "ses_root",
      title: "Continue?",
      fields: [{ key: "continue", type: "boolean", required: true }]
    }
  ];
  const permissions = [
    {
      id: "per_request",
      sessionID: "ses_root",
      action: "test",
      resources: ["exact-resource"]
    }
  ];
  const api: ManagedSessionAPI = {
    sessions: {
      form: {
        list: async () => forms,
        reply: async (input) => {
          replies.push(input);
          forms.splice(0);
        },
        cancel: async (input) => {
          replies.push(input);
          forms.splice(0);
        }
      }
    },
    permission: {
      list: async () => permissions,
      reply: async (input) => {
        replies.push(input);
        permissions.splice(0);
      }
    },
    experimental: {
      session: {
        stats: async () => ({
          range: { from: 0, to: 1 },
          sessions: 1,
          subagents: 0,
          prompts: 0,
          steps: 0,
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 }
          },
          tools: {
            mode: "summary",
            totals: { calls: 0, succeeded: 0, failed: 0, unfinished: 0 }
          },
          activeDays: 0,
          streak: 0,
          activity: [],
          models: []
        })
      },
      usage: {
        limits: async () => ({ location: { directory: "/" }, data: null })
      }
    }
  };
  let opened = 0;
  const managed = new ManagedSession({
    session: "ses_root",
    open: async () => {
      opened++;
      return api;
    },
    assertActive: async () => {
      if (!active) throw new Error("409: Attempt was cancelled");
    }
  });
  return {
    api,
    managed,
    replies,
    forms,
    permissions,
    cancel: () => {
      active = false;
    },
    opened: () => opened
  };
}

it("reads native pending requests without maintaining another approval store", async () => {
  const f = fixture();
  expect(await f.managed.pending()).toMatchObject({
    session: "ses_root",
    forms: [{ id: "frm_question" }],
    permissions: [{ id: "per_request" }]
  });
  await f.managed.replyForm("frm_question", {
    session: "ses_root",
    answer: { continue: true }
  });
  expect((await f.managed.pending()).forms).toEqual([]);
  expect(f.replies).toEqual([
    {
      sessionID: "ses_root",
      formID: "frm_question",
      answer: { continue: true }
    }
  ]);
  expect(f.opened()).toBe(3);
  await expect(
    f.managed.replyForm("frm_question", {
      session: "ses_root",
      answer: { continue: true }
    })
  ).rejects.toThrow("409:");
  expect(f.replies).toHaveLength(1);
});

it("requires the exact native session and request identities", async () => {
  const f = fixture();
  await expect(
    f.managed.replyPermission("per_request", {
      session: "ses_other",
      decision: "once"
    })
  ).rejects.toThrow("409:");
  await expect(
    f.managed.replyPermission("per_other", {
      session: "ses_root",
      decision: "once"
    })
  ).rejects.toThrow("409:");
  await expect(
    f.managed.replyForm("per_request", { session: "ses_root", answer: {} })
  ).rejects.toThrow("400:");
  await expect(
    f.managed.replyPermission("per_request", {
      session: "ses_root",
      decision: "always"
    })
  ).rejects.toThrow("400:");
  expect(f.replies).toEqual([]);
  await f.managed.replyPermission("per_request", {
    session: "ses_root",
    decision: "once"
  });
  expect(f.replies).toEqual([
    { sessionID: "ses_root", requestID: "per_request", decision: "once" }
  ]);
  await expect(
    f.managed.replyPermission("per_request", {
      session: "ses_root",
      decision: "reject"
    })
  ).rejects.toThrow("409:");
});

it("rechecks cancellation after the pending lookup before allowing a native reply", async () => {
  const f = fixture();
  f.api.permission.list = async () => {
    f.cancel();
    return f.permissions;
  };
  await expect(
    f.managed.replyPermission("per_request", {
      session: "ses_root",
      decision: "once"
    })
  ).rejects.toThrow("cancelled");
  expect(f.replies).toEqual([]);
});

it("keeps native field validation and cancellation in the native form API", async () => {
  const f = fixture();
  await expect(
    f.managed.replyForm("frm_question", {
      session: "ses_root",
      answer: { continue: { bad: true } }
    })
  ).rejects.toThrow("400:");
  expect(f.replies).toEqual([]);
  await f.managed.cancelForm("frm_question", {
    session: "ses_root",
    message: "Operator declined"
  });
  expect(f.replies).toEqual([
    {
      sessionID: "ses_root",
      formID: "frm_question",
      message: "Operator declined"
    }
  ]);
});

it("reads local usage even when Console limits are unavailable", async () => {
  const f = fixture();
  expect(await f.managed.usage()).toMatchObject({
    stats: { sessions: 1, steps: 0 },
    limits: null,
    limitsStatus: "not-connected"
  });
  f.api.experimental.usage.limits = async () => {
    throw new Error("provider secret response");
  };
  expect(await f.managed.usage()).toMatchObject({
    stats: { sessions: 1 },
    limits: null,
    limitsStatus: "unavailable"
  });
  expect(JSON.stringify(await f.managed.usage())).not.toContain(
    "provider secret"
  );
});
