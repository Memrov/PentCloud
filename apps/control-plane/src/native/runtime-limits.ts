export type DynamicWorkerKind = "prompt-renderer" | "shell" | "javascript";
export type DynamicWorkerBudget = Required<workerdResourceLimits>;

/** Per invocation compute/I/O bounds; these impose no attempt lifetime deadline. */
export const dynamicWorkerBudgets = {
  "prompt-renderer": { cpuMs: 30000, subRequests: 1 },
  shell: { cpuMs: 30000, subRequests: 256 },
  javascript: { cpuMs: 30000, subRequests: 256 },
} satisfies Record<DynamicWorkerKind, DynamicWorkerBudget>;

/** The Computer SDK accepts a structural Loader but does not expose shell/subrequest limits. */
export function budgetLoader(
  loader: WorkerLoader,
  budget: DynamicWorkerBudget,
  tails: Fetcher[] = [],
): WorkerLoader {
  const bounded = (code: WorkerLoaderWorkerCode): WorkerLoaderWorkerCode => ({
    ...code,
    limits: {
      cpuMs: Math.min(code.limits?.cpuMs ?? budget.cpuMs, budget.cpuMs),
      subRequests: Math.min(code.limits?.subRequests ?? budget.subRequests, budget.subRequests),
    },
    ...(tails.length ? { tails: [...code.tails ?? [], ...tails] } : {}),
  });
  return {
    get: (name, getCode) => loader.get(
      name === null ? null : `${name}:pentcloud-budget-${budget.cpuMs}-${budget.subRequests}`,
      async () => bounded(await getCode()),
    ),
    load: code => loader.load(bounded(code)),
  };
}
