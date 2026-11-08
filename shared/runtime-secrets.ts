import { SEARCH_PROVIDERS } from "./search-providers";

/** Plain binding redaction only; never resolve Secrets Store getters here. */
export function knownRuntimeSecrets(env: object): string[] {
  return [
    "CONTROL_TOKEN",
    ...SEARCH_PROVIDERS.map((provider) => provider.binding)
  ].flatMap((name) => {
    const value = Reflect.get(env, name);
    return typeof value === "string" && value ? [value] : [];
  });
}
