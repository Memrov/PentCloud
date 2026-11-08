import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import {
  answerForForm,
  fieldShown,
  NativeQuestion
} from "../src/ui/components/session-controls";
import {
  answerNativeForm,
  parseSessionControls,
  replyNativePermission
} from "../src/ui/api";
import type { PendingForm } from "../src/native/managed-session";

const form: PendingForm = {
  id: "frm_question",
  sessionID: "ses_root",
  title: "Native choices",
  fields: [
    { key: "continue", type: "boolean", title: "Continue", required: true },
    {
      key: "method",
      type: "string",
      title: "Method",
      options: [{ value: "safe", label: "Safe choice" }],
      when: [{ key: "continue", op: "eq", value: true }]
    },
    {
      key: "external",
      type: "external",
      title: "Complete sign-in",
      url: "https://example.com/login"
    }
  ]
};

it("shows offered choices and descriptions for the stock question tool's custom string field", () => {
  // Exact shape produced by question.toField in OpenCode 2.2.5.
  const question: PendingForm = {
    id: "frm_stock_question",
    sessionID: "ses_root",
    title: "Questions",
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Approach",
        description: "Which approach should continue?",
        options: [
          {
            value: "Focused",
            label: "Focused",
            description: "Keep the existing scope"
          },
          {
            value: "Broader",
            label: "Broader",
            description: "Include the optional section"
          }
        ],
        custom: true
      }
    ]
  };
  const html = renderToStaticMarkup(
    createElement(NativeQuestion, {
      form: question,
      disabled: false,
      onAnswer: () => {},
      onCancel: () => {}
    })
  );
  expect(html).toContain("Focused");
  expect(html).toContain("Keep the existing scope");
  expect(html).toContain("Broader");
  expect(html).toContain("Include the optional section");
  expect(html).toContain('role="combobox"');
  const multiple: PendingForm = {
    ...question,
    fields: [
      {
        key: "q0",
        type: "multiselect",
        title: "Approaches",
        options: [
          {
            value: "Focused",
            label: "Focused",
            description: "Keep the existing scope"
          }
        ],
        custom: true
      }
    ]
  };
  expect(
    renderToStaticMarkup(
      createElement(NativeQuestion, {
        form: multiple,
        disabled: false,
        onAnswer: () => {},
        onCancel: () => {}
      })
    )
  ).toContain("Keep the existing scope");
  expect(
    answerForForm(
      {
        ...question,
        fields: [
          ...question.fields,
          {
            key: "followup",
            type: "string",
            when: [{ key: "q0", op: "eq", value: "Focused" }]
          }
        ]
      },
      { q0: "My custom answer", followup: "stale" }
    )
  ).toEqual({ q0: "My custom answer" });
});

it("renders native field controls and requires an explicit external-step acknowledgement", () => {
  const html = renderToStaticMarkup(
    createElement(NativeQuestion, {
      form,
      disabled: false,
      onAnswer: () => {},
      onCancel: () => {}
    })
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("I completed this step");
  expect(html).toContain("external-link");
  expect(html).not.toContain('href="https:');
  expect(html).toContain("Send answer");
  expect(html).not.toContain("Safe choice");
  expect(html).not.toContain("JSON");
});

it("omits answers for conditional fields that became inactive", () => {
  expect(fieldShown(form.fields[1]!, { continue: true })).toBe(true);
  expect(fieldShown(form.fields[1]!, { continue: false })).toBe(false);
  expect(
    answerForForm(form, { continue: false, method: "safe", external: true })
  ).toEqual({ continue: false, external: true });
});

it("sends form answers and permission decisions to separate exact native identities", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ replied: true });
  };
  await answerNativeForm(
    "job-1",
    "ses_root",
    "frm_exact",
    { continue: true },
    fetcher
  );
  await replyNativePermission(
    "job-1",
    "ses_root",
    "per_exact",
    "once",
    fetcher
  );
  expect(requests).toEqual([
    {
      url: "/v1/ui/jobs/job-1/forms/frm_exact/reply",
      body: { session: "ses_root", answer: { continue: true } }
    },
    {
      url: "/v1/ui/jobs/job-1/permissions/per_exact/reply",
      body: { session: "ses_root", decision: "once" }
    }
  ]);
});

it("validates native form fields and projects only displayed usage fields", () => {
  const value = {
    session: "ses_root",
    canReply: true,
    forms: [{ ...form, metadata: { private: "omit" } }],
    permissions: [],
    usage: {
      stats: {
        steps: 2,
        tokens: { input: 10, output: 20 },
        cost: 0,
        tools: { mode: "summary", totals: { calls: 1, failed: 0 } },
        providerSettings: { apiKey: "omit" }
      },
      limits: null,
      limitsStatus: "not-connected"
    }
  };
  expect(parseSessionControls(value).forms[0]?.fields).toEqual(form.fields);
  expect(JSON.stringify(parseSessionControls(value))).not.toContain("omit");
  expect(() =>
    parseSessionControls({
      ...value,
      forms: [{ ...form, sessionID: "ses_other" }]
    })
  ).toThrow("invalid");
  expect(() =>
    parseSessionControls({
      ...value,
      forms: [
        {
          ...form,
          fields: [
            { key: "bad", type: "multiselect", options: ["not an option"] }
          ]
        }
      ]
    })
  ).toThrow("invalid");
  expect(() =>
    parseSessionControls({
      ...value,
      forms: [
        { ...form, fields: [{ key: "bad", type: "boolean", default: "true" }] }
      ]
    })
  ).toThrow("invalid");
  expect(
    parseSessionControls({
      ...value,
      usage: {
        ...value.usage,
        limits: {
          go: {
            rolling: { percent: 105 },
            weekly: { percent: 40 },
            monthly: { percent: 60 }
          },
          budgets: []
        }
      }
    }).usage.limits?.go?.rolling.percent
  ).toBe(105);
  expect(() =>
    parseSessionControls({
      ...value,
      usage: {
        ...value.usage,
        limits: {
          go: {
            rolling: { percent: -1 },
            weekly: { percent: 40 },
            monthly: { percent: 60 }
          },
          budgets: []
        }
      }
    })
  ).toThrow("invalid");
});
