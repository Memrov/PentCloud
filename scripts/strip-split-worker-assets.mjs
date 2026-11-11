import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Pass the built Worker wrangler.json path");
const config = JSON.parse(await readFile(path, "utf8"));
if (
  !["pentcloud-dev-coordinator", "pentcloud-dev-attempt"].includes(config.name)
)
  throw new Error(
    "Only isolated Coordinator and Attempt Workers may omit UI assets"
  );
if (config.route || config.routes?.length || config.domains?.length)
  throw new Error("An isolated Worker cannot own the public UI domain");
delete config.assets;
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Removed UI assets from ${config.name} deployment config`);
