import type { CredentialMetadata } from "./onboarding";

const slots = [
  {
    id: "bound-go",
    binding: "OPENCODE_GO_API_KEY",
    label: "OpenCode workspace key"
  },
  {
    id: "bound-console",
    binding: "OPENCODE_API_KEY",
    label: "OpenCode Console"
  }
] as const;
function binding(
  env: object,
  name: string
): string | SecretsStoreSecret | undefined {
  const value: unknown = Reflect.get(env, name);
  if (typeof value === "string" && value.trim()) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof Reflect.get(value, "get") === "function"
  )
    return value as SecretsStoreSecret;
}
/** Metadata only. A Store binding is not read until an authorized model operation. */
export function modelSecretMetadata(env: object): CredentialMetadata[] {
  return slots.flatMap((slot) =>
    binding(env, slot.binding)
      ? [
          {
            id: slot.id,
            purpose: "model" as const,
            label: slot.label + " · Cloudflare",
            version: 0,
            revoked: false,
            updatedAt: 0,
            updatedBy: "Cloudflare",
            binding: slot.binding
          }
        ]
      : []
  );
}
export async function readModelSecret(
  env: object,
  id: string
): Promise<string> {
  const slot = slots.find((slot) => slot.id === id),
    value = slot && binding(env, slot.binding);
  if (!value)
    throw new Error("409: Configure the OpenCode secret binding in Cloudflare");
  let secret: string;
  try {
    secret = typeof value === "string" ? value : await value.get();
  } catch {
    throw new Error("503: Cloudflare OpenCode secret binding unavailable");
  }
  if (typeof secret !== "string" || !secret.trim())
    throw new Error("409: Cloudflare OpenCode secret binding is empty");
  return secret;
}
export function plainModelSecretValues(env: object): string[] {
  return slots.flatMap((slot) => {
    const value = binding(env, slot.binding);
    return typeof value === "string" ? [value] : [];
  });
}
