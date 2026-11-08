import { describe, expect, it } from "vitest";
import {
  validateClefAuditRequest,
  validateClefResponse
} from "../src/native/clef";

const questions = {
  risk: {
    type: "choice" as const,
    instructions: "Assess evidence",
    criteria: { low: "No demonstrated risk", high: "Confirmed risk" }
  }
};
describe("native immutable evidence audit validation", () => {
  it("requires immutable source commits and confined evidence paths", () => {
    const request = {
      model: "clef",
      sources: [
        {
          job_id: "specialist",
          commit: "a".repeat(40),
          paths: ["src/evidence.txt"]
        }
      ],
      questions,
      message: "Triage immutable evidence"
    };
    expect(validateClefAuditRequest(request)).toEqual(request);
    expect(() =>
      validateClefAuditRequest({
        ...request,
        sources: [{ job_id: "specialist", commit: "main" }]
      })
    ).toThrow();
    expect(() =>
      validateClefAuditRequest({
        ...request,
        sources: [
          {
            job_id: "specialist",
            commit: "a".repeat(40),
            paths: ["../outside"]
          }
        ]
      })
    ).toThrow();
  });
  it("rejects invented choices, missing questions and malformed probabilities", () => {
    expect(() => validateClefResponse({ answers: {} }, questions)).toThrow();
    expect(() =>
      validateClefResponse(
        {
          answers: {
            risk: {
              type: "choice",
              choice: "unknown",
              probabilities: { low: 0, high: 1 }
            }
          }
        },
        questions
      )
    ).toThrow();
    expect(() =>
      validateClefResponse(
        {
          answers: {
            risk: {
              type: "choice",
              choice: "high",
              probabilities: { low: 0, high: 2 }
            }
          }
        },
        questions
      )
    ).toThrow();
    expect(
      validateClefResponse(
        {
          answers: {
            risk: {
              type: "choice",
              choice: "high",
              probabilities: { low: 0.1, high: 0.9 }
            }
          }
        },
        questions
      )
    ).toEqual({
      risk: {
        type: "choice",
        choice: "high",
        probabilities: { low: 0.1, high: 0.9 }
      }
    });
  });
});
