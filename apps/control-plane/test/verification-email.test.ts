import { expect, it } from "vite-plus/test";
import {
  readVerificationEmail,
  verificationContent
} from "../src/native/verification-email";
const raw = (body: string) =>
  "From: Login <login@owned.example>\r\nTo: codes+abc@auth.example\r\nDate: Thu, 05 Nov 2026 12:00:00 +0000\r\nMessage-ID: <one@owned.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
  body;
const headers = new Headers({
  "Authentication-Results":
    "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=owned.example"
});
it("extracts a bounded code without returning a whole email or its subject", async () => {
  const result = await readVerificationEmail({
    to: "codes+abc@auth.example",
    headers,
    raw: raw("Your verification code is 384217. Copyright 2026.")
  });
  expect(result?.code).toBe("384217");
  expect(result?.from).toBe("login@owned.example");
  expect(result).not.toHaveProperty("body");
});
it("ignores spoofed authentication results and ambiguous or oversized messages", async () => {
  for (const auth of [
    "attacker.test; dmarc=pass",
    "mx.cloudflare.net; dmarc=fail, attacker.test; dmarc=pass"
  ])
    expect(
      await readVerificationEmail({
        to: "codes+abc@auth.example",
        headers: new Headers({ "Authentication-Results": auth }),
        raw: raw("Your code is 384217")
      })
    ).toBeUndefined();
  expect(
    (
      await readVerificationEmail({
        to: "codes+abc@auth.example",
        headers,
        raw: raw("Your code is 384217 or code 948235")
      })
    )?.code
  ).toBeUndefined();
  expect(
    await readVerificationEmail({
      to: "codes+abc@auth.example",
      headers,
      raw: "x".repeat(256 * 1024 + 1)
    })
  ).toBeUndefined();
});
it("keeps a usable magic link despite unrelated numbers and gives the agent bounded fallback text for other code formats", () => {
  const content = verificationContent(
    "Request 123456 from device 654321. Sign in at https://owned.example/verify?token=abc"
  );
  expect(content?.links).toEqual(["https://owned.example/verify?token=abc"]);
  expect(content?.code).toBeUndefined();
  expect(
    verificationContent("Your verification code is ABCD-EFGH")?.excerpt
  ).toContain("ABCD-EFGH");
  expect(
    verificationContent("", "<p>Your verification code is ABCD-EFGH</p>")
      ?.excerpt
  ).toContain("ABCD-EFGH");
  expect(
    verificationContent("word ".repeat(10000))?.excerpt?.length
  ).toBeLessThanOrEqual(1000);
});
it("trusts only the first authentication header, ignoring comment and version spoofing", async () => {
  for (const suffix of [
    "attacker.test 1; dmarc=pass",
    "attacker.test ; dmarc=pass",
    "mx.cloudflare.net; dmarc=pass"
  ]) {
    const h = new Headers({
      "Authentication-Results": "mx.cloudflare.net; dmarc=fail"
    });
    h.append("Authentication-Results", suffix);
    expect(
      await readVerificationEmail({
        to: "codes+abc@auth.example",
        headers: h,
        raw: raw("Your code is 384217")
      })
    ).toBeUndefined();
  }
  expect(
    await readVerificationEmail({
      to: "codes+abc@auth.example",
      headers: new Headers({
        "Authentication-Results":
          "mx.cloudflare.net; dkim=fail (ignored; dmarc=pass); dmarc=fail"
      }),
      raw: raw("Your code is 384217")
    })
  ).toBeUndefined();
  expect(
    (
      await readVerificationEmail({
        to: "codes+abc@auth.example",
        headers: new Headers({
          "Authentication-Results":
            "mx.cloudflare.net; dkim=pass (valid, signed); dmarc=pass header.from=owned.example, attacker.test 1; dmarc=fail"
        }),
        raw: raw("Your code is 384217")
      })
    )?.code
  ).toBe("384217");
});
it("accepts Cloudflare-verified aligned DKIM when the sender has no DMARC policy", async () => {
  const auth =
    "mx.cloudflare.net; dkim=pass header.d=owned.example; dmarc=none header.from=owned.example";
  expect(
    (
      await readVerificationEmail({
        to: "codes+abc@auth.example",
        headers: new Headers({ "Authentication-Results": auth }),
        raw: raw("Your code is 384217")
      })
    )?.code
  ).toBe("384217");
  for (const invalid of [
    auth.replace("header.d=owned.example", "header.d=other.example"),
    auth.replace("dmarc=none", "dmarc=fail"),
    auth.replace("dkim=pass", "dkim=fail (dkim=pass header.d=owned.example)")
  ])
    expect(
      await readVerificationEmail({
        to: "codes+abc@auth.example",
        headers: new Headers({ "Authentication-Results": invalid }),
        raw: raw("Your code is 384217")
      })
    ).toBeUndefined();
});
