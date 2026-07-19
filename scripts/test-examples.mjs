import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("dist/cli.js");
const examples = [
  "examples/partitioned-notes.yml",
  "examples/automerge-shopping-list.yml",
  "examples/custom-adapter/scenario.yml",
];

for (const example of examples) {
  const result = spawnSync(process.execPath, [cli, "run", resolve(example), "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`Example failed: ${example}\n${result.stdout}${result.stderr}`);
    process.exit(result.status ?? 1);
  }
  const report = JSON.parse(result.stdout);
  if (report.status !== "pass") {
    process.stderr.write(`Example did not pass: ${example}\n${result.stdout}`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${example}\n`);
}
