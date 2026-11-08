import { expect, it } from "vite-plus/test";
import { verificationGuidance } from "../../../shared/verification-guidance";
it("uses the imported platform identity without replacing the program registration rules", () => {
  expect(verificationGuidance("hackerone").alias).toContain(
    "wearehackerone.com"
  );
  expect(verificationGuidance("intigriti").alias).toContain("intigriti.me");
  expect(verificationGuidance("bugcrowd").alias).toContain("bugcrowdninja.com");
  for (const platform of ["yeswehack", "unknown", undefined])
    expect(verificationGuidance(platform).alias).toBeUndefined();
  expect(verificationGuidance("HackerOne")).toEqual(
    verificationGuidance("hackerone")
  );
});
