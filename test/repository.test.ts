import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import packageJson from "../package.json" with { type: "json" };
import releaseManifest from "../.release-please-manifest.json" with { type: "json" };
import { SYNCLAB_VERSION } from "../src/version.js";

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, output));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, output));
  return output;
}

test("all GitHub workflows parse and pin third-party actions to immutable SHAs", async () => {
  const directory = resolve(".github/workflows");
  const files = (await readdir(directory)).filter((file) => [".yml", ".yaml"].includes(extname(file)));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const path = resolve(directory, file);
    const workflow = parseYaml(await readFile(path, "utf8")) as unknown;
    assert.ok(workflow && typeof workflow === "object", `${file} did not parse as an object`);
    const actions = collectStrings(workflow).filter((value) => /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?@/.test(value));
    for (const action of actions) {
      assert.match(action, /@[0-9a-f]{40}$/, `${file} must pin ${action} to a full commit SHA`);
    }
  }
});

test("release workflow never publishes to npm before trusted publishing is configured", async () => {
  const release = await readFile(resolve(".github/workflows/release-please.yml"), "utf8");
  const executableLines = release.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#"));
  assert.equal(executableLines.some((line) => /npm\s+publish/.test(line)), false);
});

test("package, source, and release manifest versions agree", () => {
  assert.equal(packageJson.version, SYNCLAB_VERSION);
  assert.equal(releaseManifest["."], SYNCLAB_VERSION);
});

test("local Markdown links resolve", async () => {
  const markdownFiles = [
    "README.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "SUPPORT.md",
    "GOVERNANCE.md",
    "ROADMAP.md",
    ...((await readdir(resolve("docs"))).filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`)),
  ];
  const missing: string[] = [];
  for (const file of markdownFiles) {
    const source = await readFile(resolve(file), "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1]!;
      if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
      const target = decodeURIComponent(raw.split("#")[0]!);
      if (target && !existsSync(resolve(dirname(resolve(file)), target))) missing.push(`${file} -> ${raw}`);
    }
  }
  assert.deepEqual(missing, []);
});
