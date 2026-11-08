import { spawnSync } from "node:child_process";
const binary = process.env.PENTCLOUD_GO_BINARY ?? process.env.GO_BIN ?? "go";
if (
  spawnSync(binary, ["env", "GOVERSION"], {
    encoding: "utf8"
  }).stdout?.trim() !== "go1.26.5"
)
  throw new Error(
    "Full checks require Go 1.26.5. Set GO_BIN locally; pin GO_VERSION=1.26.5 in Workers Builds."
  );
for (const args of [
  ["test", "./...", "-count=1"],
  ["vet", "./..."]
]) {
  const result = spawnSync(binary, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
