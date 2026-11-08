export type ClefModel = "clef-flash" | "clef";

export type ClefQuestion =
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface ClefAuditRequest {
  model: ClefModel;
  sources: Array<{ job_id: string; commit: string; paths?: string[] }>;
  questions: Record<string, ClefQuestion>;
  message: string;
}

export interface ClefAI {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export interface ClefChunkSource {
  job_id: string;
  repo: string;
  commit: string;
  path: string;
  start_byte: number;
  end_byte: number;
}

export interface ClefAuditResult {
  audit_id: string;
  model: ClefModel;
  chunks: Array<{ source: ClefChunkSource; answers: Record<string, unknown> }>;
  skipped: Array<{
    job_id: string;
    repo: string;
    commit: string;
    path: string;
    reason: string;
  }>;
  truncated: boolean;
}

const MAX_SOURCES = 32;
const MAX_FILES = 128;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES = 48 * 1024;
const MAX_CHUNKS = 64;
const MAX_QUESTIONS = 64;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const commitID = /^[a-f0-9]{40}$/;
const questionID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validateClefAuditRequest(input: unknown): ClefAuditRequest {
  if (!isRecord(input)) throw new Error("Clef audit request must be an object");
  exactKeys(
    input,
    ["model", "sources", "questions", "message"],
    "Clef audit request"
  );
  if (input.model !== "clef-flash" && input.model !== "clef")
    throw new Error("Clef audit model is invalid");
  if (
    !Array.isArray(input.sources) ||
    input.sources.length < 1 ||
    input.sources.length > MAX_SOURCES
  ) {
    throw new Error(`Clef audit requires from 1 to ${MAX_SOURCES} sources`);
  }
  const sources = input.sources.map((value, index) => {
    if (!isRecord(value))
      throw new Error(`Clef source ${index} must be an object`);
    exactKeys(value, ["job_id", "commit", "paths"], `Clef source ${index}`);
    if (typeof value.job_id !== "string" || !identifier.test(value.job_id))
      throw new Error(`Clef source ${index} job_id is invalid`);
    if (typeof value.commit !== "string" || !commitID.test(value.commit))
      throw new Error(`Clef source ${index} commit is invalid`);
    let paths: string[] | undefined;
    if (value.paths !== undefined) {
      if (
        !Array.isArray(value.paths) ||
        value.paths.length < 1 ||
        value.paths.length > MAX_FILES
      ) {
        throw new Error(`Clef source ${index} paths are invalid`);
      }
      paths = value.paths.map((path) => {
        if (typeof path !== "string" || path.length > 1024)
          throw new Error(`Clef source ${index} path is invalid`);
        validatePath(path);
        return path;
      });
      if (new Set(paths).size !== paths.length)
        throw new Error(`Clef source ${index} paths must be unique`);
    }
    return {
      job_id: value.job_id,
      commit: value.commit,
      ...(paths ? { paths } : {})
    };
  });
  if (!isRecord(input.questions))
    throw new Error("Clef questions must be an object");
  const questionEntries = Object.entries(input.questions);
  if (questionEntries.length < 1 || questionEntries.length > MAX_QUESTIONS) {
    throw new Error(`Clef audit requires from 1 to ${MAX_QUESTIONS} questions`);
  }
  const questions = Object.fromEntries(
    questionEntries.map(([id, value]): [string, ClefQuestion] => {
      if (!questionID.test(id))
        throw new Error(`Clef question ID ${id} is invalid`);
      if (!isRecord(value))
        throw new Error(`Clef question ${id} must be an object`);
      if (
        typeof value.instructions !== "string" ||
        value.instructions.trim().length === 0 ||
        value.instructions.length > 4000
      ) {
        throw new Error(`Clef question ${id} instructions are invalid`);
      }
      if (value.type === "noul") {
        exactKeys(
          value,
          ["type", "instructions", "criteria"],
          `Clef question ${id}`
        );
        let criteria: { true?: string; false?: string } | undefined;
        if (value.criteria !== undefined) {
          if (!isRecord(value.criteria))
            throw new Error(`Clef question ${id} criteria are invalid`);
          exactKeys(
            value.criteria,
            ["true", "false"],
            `Clef question ${id} criteria`
          );
          criteria = {};
          for (const key of ["true", "false"] as const) {
            const text = value.criteria[key];
            if (text !== undefined) {
              if (
                typeof text !== "string" ||
                text.trim().length === 0 ||
                text.length > 2000
              )
                throw new Error(`Clef question ${id} criteria are invalid`);
              criteria[key] = text;
            }
          }
        }
        return [
          id,
          {
            type: "noul",
            instructions: value.instructions,
            ...(criteria ? { criteria } : {})
          }
        ];
      }
      if (value.type === "choice") {
        exactKeys(
          value,
          ["type", "instructions", "criteria"],
          `Clef question ${id}`
        );
        if (!isRecord(value.criteria))
          throw new Error(`Clef question ${id} choice criteria are invalid`);
        const entries = Object.entries(value.criteria);
        if (entries.length < 2)
          throw new Error(`Clef question ${id} requires at least two choices`);
        if (entries.length > 255)
          throw new Error(`Clef question ${id} has too many choices`);
        const criteria = Object.fromEntries(
          entries.map(([key, text]) => {
            if (
              !questionID.test(key) ||
              typeof text !== "string" ||
              text.trim().length === 0 ||
              text.length > 2000
            ) {
              throw new Error(
                `Clef question ${id} choice criteria are invalid`
              );
            }
            return [key, text];
          })
        );
        return [
          id,
          { type: "choice", instructions: value.instructions, criteria }
        ];
      }
      if (value.type === "score") {
        exactKeys(
          value,
          ["type", "instructions", "criteria"],
          `Clef question ${id}`
        );
        if (
          !Array.isArray(value.criteria) ||
          value.criteria.length < 2 ||
          value.criteria.length > 10 ||
          value.criteria.some(
            (text) =>
              typeof text !== "string" ||
              text.trim().length === 0 ||
              text.length > 2000
          )
        ) {
          throw new Error(`Clef question ${id} score criteria are invalid`);
        }
        return [
          id,
          {
            type: "score",
            instructions: value.instructions,
            criteria: [...value.criteria] as string[]
          }
        ];
      }
      throw new Error(`Clef question ${id} type is invalid`);
    })
  );
  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > 2000
  ) {
    throw new Error("Clef audit message is invalid");
  }
  return { model: input.model, sources, questions, message: input.message };
}

export function validateClefResponse(
  response: unknown,
  questions: Record<string, ClefQuestion>
): Record<string, unknown> {
  if (!isRecord(response) || !isRecord(response.answers))
    throw new Error("Clef response has no answers");
  const responseAnswers = response.answers;
  const questionIDs = Object.keys(questions);
  const answerIDs = Object.keys(responseAnswers);
  if (
    answerIDs.length !== questionIDs.length ||
    questionIDs.some((id) => !Object.hasOwn(responseAnswers, id))
  ) {
    throw new Error("Clef response answer set is malformed");
  }
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = responseAnswers[id];
    if (!isRecord(answer) || answer.type !== question.type)
      throw new Error(`Clef answer ${id} is malformed`);
    if (question.type === "noul") {
      if (!probability(answer.noul))
        throw new Error(`Clef answer ${id} has an invalid probability`);
    } else if (question.type === "choice") {
      if (
        typeof answer.choice !== "string" ||
        !Object.hasOwn(question.criteria, answer.choice) ||
        !probabilityMap(answer.probabilities, Object.keys(question.criteria))
      ) {
        throw new Error(`Clef answer ${id} is malformed`);
      }
    } else if (
      !Number.isInteger(answer.score) ||
      (answer.score as number) < 0 ||
      (answer.score as number) > question.criteria.length - 1 ||
      !probabilityMap(
        answer.probabilities,
        question.criteria.map((_, index) => String(index))
      )
    ) {
      throw new Error(`Clef answer ${id} is malformed`);
    }
    answers[id] = structuredClone(answer);
  }
  return answers;
}

function probabilityMap(value: unknown, keys: string[]): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key) && probability(value[key]))
  );
}

function probability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe Clef source path ${path}`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string
): void {
  const accepted = new Set(allowed);
  const extra = Object.keys(value).find((key) => !accepted.has(key));
  if (extra) throw new Error(`${name} contains unsupported field ${extra}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
