import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vite-plus/test";
const key = generateKeyPair("ES256");
export function accessKeys() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== "https://access.invalid/cdn-cgi/access/certs")
      throw Error("Unexpected fixture network request");
    return Response.json({
      keys: [
        {
          ...(await exportJWK((await key).publicKey)),
          kid: "runtime-access-key",
          alg: "ES256"
        }
      ]
    });
  });
}
export async function accessToken(
  issuer = "https://access.invalid",
  audience = "runtime-test-audience",
  email = "operator",
  expiry: string | number | null = "2m"
) {
  const token = new SignJWT({ email })
    .setProtectedHeader({ alg: "ES256", kid: "runtime-access-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt();
  if (expiry !== null) token.setExpirationTime(expiry);
  return token.sign((await key).privateKey);
}
export async function accessHeaders(initial?: HeadersInit) {
  const h = new Headers(initial);
  h.set("Cf-Access-Jwt-Assertion", await accessToken());
  return h;
}
