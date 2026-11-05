/** Legacy fixture redaction only. Authentication is signed Cloudflare Access
 * identity; no runtime path reads an operator secret or Secrets Store. */
export function knownRuntimeSecrets(env: object): string[] {
  const value=Reflect.get(env,"CONTROL_TOKEN");
  return typeof value==="string"&&value?[value]:[];
}
