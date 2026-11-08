import { it, expect } from "vite-plus/test";
import { RunBrowserAuth } from "../src/native/run-browser-auth";
const target = {
  id: "site",
  url: "https://example.com/",
  access: {
    headers: [],
    login: {
      url: "https://example.com/login",
      usernameBinding: "PENTCLOUD_TARGET_USER",
      passwordBinding: "PENTCLOUD_TARGET_PASS"
    }
  }
};
const state = {
  cookies: [
    {
      name: "session",
      value: "private-cookie",
      domain: "example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const
    }
  ],
  origins: []
};
it("shares login among jobs only within one run, expires it, and clears terminal state", () => {
  const values = new Map<string, unknown>();
  let now = 1000;
  const auth = new RunBrowserAuth({
    get: (k) => values.get(k),
    put: (k, v) => values.set(k, v),
    remove: (k) => values.delete(k),
    now: () => now
  });
  auth.write("run-one", target, state);
  expect(auth.read("run-one", target)).toEqual(state);
  expect(auth.read("run-two", target)).toBeUndefined();
  now += 31 * 60 * 1000;
  expect(auth.read("run-one", target)).toBeUndefined();
  expect(values.size).toBe(0);
  auth.write("run-one", target, state);
  auth.clear("run-one");
  expect(auth.read("run-one", target)).toBeUndefined();
});
it("does not restore credentials into a changed target or credential audience", () => {
  const values = new Map<string, unknown>();
  const auth = new RunBrowserAuth({
    get: (k) => values.get(k),
    put: (k, v) => values.set(k, v),
    remove: (k) => values.delete(k)
  });
  auth.write("run-one", target, state);
  expect(auth.read("run-one", { ...target, id: "other" })).toBeUndefined();
  auth.write("run-one", target, state);
  expect(
    auth.read("run-one", {
      ...target,
      access: {
        ...target.access,
        login: {
          ...target.access.login,
          passwordBinding: "PENTCLOUD_TARGET_OTHER"
        }
      }
    })
  ).toBeUndefined();
});
