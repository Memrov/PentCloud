import { expect, it } from "vite-plus/test";
import {
  targetCode,
  verificationAddress,
  verificationChallenge
} from "../src/native/target-verification";
import { validateTargetAccess } from "../../../shared/target-access";
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
it("generates the RFC6238 code locally without sending the seed to a provider", async () => {
  expect(
    await targetCode("otpauth://totp/Test?secret=" + seed + "&digits=8", 59000)
  ).toBe("94287082");
  expect(await targetCode(seed, 59000)).toBe("287082");
  expect(
    await targetCode(
      "otpauth://totp/Test?secret=" + seed + "&digits=8",
      1111111109000
    )
  ).toBe("07081804");
});
it("rejects malformed seeds and unsupported authenticator settings", async () => {
  for (const value of [
    "password!",
    "otpauth://hotp/Test?secret=" + seed,
    "otpauth://totp/Test?secret=" + seed + "&digits=20",
    "otpauth://totp/Test?secret=" + seed + "&period=0",
    "https://attacker.test/?secret=" + seed
  ])
    await expect(targetCode(value)).rejects.toThrow(/authenticator/i);
});
it("retains only verification references on saved login settings", () => {
  const login = {
    url: "https://owned.example/login",
    usernameBinding: "PENTCLOUD_TARGET_TEST_USERNAME",
    passwordBinding: "PENTCLOUD_TARGET_TEST_PASSWORD"
  };
  expect(
    validateTargetAccess("https://owned.example/", {
      headers: [],
      login: {
        ...login,
        verification: { kind: "totp", binding: "PENTCLOUD_TARGET_TEST_TOTP" }
      }
    }).login?.verification
  ).toEqual({ kind: "totp", binding: "PENTCLOUD_TARGET_TEST_TOTP" });
  expect(
    validateTargetAccess("https://owned.example/", {
      headers: [],
      login: {
        ...login,
        verification: { kind: "email", sender: "no-reply@owned.example" }
      }
    }).login?.verification
  ).toEqual({ kind: "email", sender: "no-reply@owned.example" });
  for (const verification of [
    { kind: "totp", binding: "OPENCODE_GO_API_KEY" },
    { kind: "email", sender: "attacker.test\r\nx:yes" },
    { kind: "sms" }
  ])
    expect(() =>
      validateTargetAccess("https://owned.example/", {
        headers: [],
        login: { ...login, verification }
      })
    ).toThrow(/verification/i);
});
it("uses a stable target-specific plus address and rejects unrelated mailbox syntax", async () => {
  expect(await verificationAddress("codes@auth.example", "abc")).toBe(
    "codes+ba7816bf8f01cfea414140de@auth.example"
  );
  await expect(
    verificationAddress("codes+old@auth.example", "abc")
  ).rejects.toThrow(/address/i);
  await expect(verificationAddress("codes@localhost", "abc")).rejects.toThrow(
    /address/i
  );
});
it("lets the agent read the code and only same-target verification links, without returning a mailbox body", () => {
  const reply = verificationChallenge(
    { url: "https://owned.example/" },
    {
      code: "384217",
      links: [
        "https://owned.example/verify?token=test",
        "https://other.example/verify",
        "http://owned.example/verify"
      ]
    }
  );
  expect(reply).toEqual({
    code: "384217",
    links: ["https://owned.example/verify?token=test"]
  });
  expect(reply).not.toHaveProperty("body");
});
it("passes bounded untrusted verification text to the existing browser agent for non-numeric codes", () => {
  const reply = verificationChallenge(
    { url: "https://owned.example/" },
    { excerpt: "Your code is ABCD-EFGH. " + "x".repeat(1500), links: [] }
  );
  expect(reply.verificationText).toContain("ABCD-EFGH");
  expect(reply.verificationText?.length).toBe(1000);
  expect(reply).not.toHaveProperty("body");
});
