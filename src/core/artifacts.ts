import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalStringify } from "./canonical.js";
import { ScenarioValidationError, SyncLabError } from "./errors.js";
import { runScenario } from "./runner.js";
import { validateScenario } from "./scenario.js";
import { SYNCLAB_VERSION } from "../version.js";
import type { AdapterFactory, FailureArtifact, RunOptions, Scenario, ScenarioStep } from "./types.js";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
let temporarySequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function writeArtifact(filePath: string, artifact: FailureArtifact): Promise<string> {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${temporarySequence}`;
  temporarySequence += 1;
  await writeFile(temporary, `${canonicalStringify(artifact)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, absolute);
  return absolute;
}

export async function readArtifact(filePath: string): Promise<FailureArtifact> {
  const absolute = resolve(filePath);
  const source = await readFile(absolute);
  if (source.byteLength > MAX_ARTIFACT_BYTES) throw new ScenarioValidationError([`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`]);
  const value = JSON.parse(source.toString("utf8")) as unknown;
  if (!isRecord(value) || value.format !== 1 || !isRecord(value.report) || !Array.isArray(value.events) || !Array.isArray(value.decisions)) {
    throw new ScenarioValidationError(["File is not a SyncLab artifact (format 1)"]);
  }
  const scenario = validateScenario(value.scenario);
  if (typeof value.seed !== "string") throw new ScenarioValidationError(["Artifact seed must be a string"]);
  return { ...value, scenario } as unknown as FailureArtifact;
}

export interface ReplayOptions extends RunOptions {
  allowVersionDrift?: boolean;
}

export interface ReplayResult {
  artifact: FailureArtifact;
  matched: boolean;
  expectedFingerprint: string;
  actualFingerprint: string;
}

export async function replayArtifact(recorded: FailureArtifact, options: ReplayOptions = {}): Promise<ReplayResult> {
  const recordedVersion = recorded.report.environment.synclab;
  if (!options.allowVersionDrift && recordedVersion !== SYNCLAB_VERSION) {
    throw new SyncLabError(
      "VERSION_DRIFT",
      `Artifact was created by SyncLab ${recordedVersion}; use allowVersionDrift to replay with ${SYNCLAB_VERSION}`,
    );
  }
  const artifact = await runScenario(recorded.scenario, { ...options, seed: recorded.seed });
  const sameOutcome = artifact.report.status === recorded.report.status
    && artifact.report.failureSignature === recorded.report.failureSignature;
  return {
    artifact,
    matched: sameOutcome && artifact.report.traceFingerprint === recorded.report.traceFingerprint,
    expectedFingerprint: recorded.report.traceFingerprint,
    actualFingerprint: artifact.report.traceFingerprint,
  };
}

function removeRange<T>(values: T[], start: number, count: number): T[] {
  return [...values.slice(0, start), ...values.slice(start + count)];
}

async function retainsFailure(
  scenario: Scenario,
  seed: string,
  signature: string,
  options: { adapter?: AdapterFactory; baseDirectory?: string },
): Promise<boolean> {
  try {
    const artifact = await runScenario(scenario, {
      seed,
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
      ...(options.baseDirectory === undefined ? {} : { baseDirectory: options.baseDirectory }),
    });
    return artifact.report.status === "fail" && artifact.report.failureSignature === signature;
  } catch {
    return false;
  }
}

export async function minimizeArtifact(
  artifact: FailureArtifact,
  options: { adapter?: AdapterFactory; baseDirectory?: string } = {},
): Promise<Scenario> {
  if (artifact.report.status !== "fail" || artifact.report.failureSignature === undefined) {
    throw new SyncLabError("NOT_MINIMIZABLE", "Only artifacts with an invariant failure can be minimized");
  }
  const signature = artifact.report.failureSignature;
  let steps: ScenarioStep[] = structuredClone(artifact.scenario.steps);
  let granularity = 2;
  while (steps.length >= 2) {
    const chunkSize = Math.ceil(steps.length / granularity);
    let reduced = false;
    for (let start = 0; start < steps.length; start += chunkSize) {
      const candidateSteps = removeRange(steps, start, chunkSize);
      if (candidateSteps.length === 0) continue;
      const candidate: Scenario = { ...structuredClone(artifact.scenario), steps: candidateSteps };
      if (await retainsFailure(candidate, artifact.seed, signature, options)) {
        steps = candidateSteps;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= steps.length) break;
    granularity = Math.min(steps.length, granularity * 2);
  }
  return { ...structuredClone(artifact.scenario), steps };
}
