import packageJson from "../package.json" with { type: "json" };

// Native Vite Task owns ordering; runtime evidence always comes from execution.
const fresh = (command: string | string[], dependsOn: string[] = []) => ({
  command,
  dependsOn,
  cache: false as const
});
const done = (dependsOn: string[]) =>
  fresh("node scripts/verify-environment.mjs", dependsOn);

export const verificationTasks = {
  "gate:environment": fresh("node scripts/verify-environment.mjs"),
  "gate:static": fresh("vp run check:static", ["gate:environment"]),
  "gate:app:types": fresh(
    [
      "env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG npm run types:check --workspace @pentagi-artifacts/control-plane",
      "env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG npm run types:check --workspace @pentcloud/tool-packs"
    ],
    ["gate:static"]
  ),
  "gate:test": fresh("vp test", ["gate:app:types"]),
  "gate:customer": fresh(
    "vp test --config apps/control-plane/vite.customer.config.ts",
    ["gate:app:types"]
  ),
  "gate:customer:contract": fresh(
    "node --test scripts/test-customer-deploy.mjs",
    ["gate:static"]
  ),
  "gate:app:checks": done([
    "gate:test",
    "gate:customer",
    "gate:customer:contract"
  ]),
  "gate:app:bundle": fresh(
    "npm run deploy:dry-run --workspace @pentagi-artifacts/control-plane",
    ["gate:app:checks"]
  ),
  "gate:app": done(["gate:app:bundle"]),
  "gate:toolpacks:bundle": fresh(
    "npm run build --workspace @pentcloud/tool-packs",
    ["gate:app:types"]
  ),
  "gate:go": fresh("node scripts/verify-go.mjs", ["gate:static"]),
  "gate:node": fresh(
    [
      "node --test scripts/test-native-test-harness.mjs scripts/test-native-canary-defaults.mjs",
      "node --test scripts/test-native-auth.mjs scripts/test-browser-run-qa.mjs scripts/test-cloudflare-build-config.mjs",
      "node --test apps/control-plane/test/native-kali-canary/contract.node.mjs"
    ],
    ["gate:toolpacks:bundle"]
  ),
  "gate:transport": fresh(
    [
      "node apps/control-plane/test/native-coordinator-probe/state.mjs",
      "node scripts/test-native-attempt-runtime.mjs"
    ],
    ["gate:app:types"]
  ),
  "gate:fixtures": done(["gate:go", "gate:node", "gate:transport"]),
  "gate:app:full:checks": done(["gate:app:checks", "gate:fixtures"]),
  "gate:app:full": done(["gate:app", "gate:fixtures"]),
  "gate:gateway:types": fresh(
    "env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG npm run types:check --workspace @pentagi-artifacts/aws-toolbox-control",
    ["gate:static"]
  ),
  "gate:gateway": fresh(
    "env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG npm test --workspace @pentagi-artifacts/aws-toolbox-control",
    ["gate:gateway:types"]
  ),
  "gate:all:checks": done(["gate:app:checks", "gate:gateway"]),
  "gate:all": done(["gate:app", "gate:gateway"]),
  "gate:all:full:checks": done(["gate:app:full:checks", "gate:gateway"]),
  "gate:all:full": done(["gate:app:full", "gate:gateway"]),
  "gate:browser": fresh(packageJson.scripts["test:browser"]),
  "gate:customer:build": fresh(packageJson.scripts.build),
  "gate:customer:deploy": fresh(packageJson.scripts.deploy)
};
