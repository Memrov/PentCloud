import { existsSync } from "node:fs";
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major !== 26 || minor < 12 || (minor === 12 && patch < 1))
  throw new Error("Node 26.12.1 or later 26.x is required");
if (!existsSync("node_modules/wrangler/bin/wrangler.js"))
  throw new Error(
    "Dependencies are missing. Run vp install --frozen-lockfile."
  );
