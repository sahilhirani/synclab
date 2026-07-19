import { resolveAdapter } from "../adapters/index.js";
import { SYNCLAB_VERSION } from "../version.js";
import { evaluateAssertion } from "./assertions.js";
import { CANONICAL_FORMAT, canonicalize, hashValue } from "./canonical.js";
import { errorMessage, ResourceLimitError, ScenarioValidationError, SyncLabError } from "./errors.js";
import { SimulatedNetwork } from "./network.js";
import { DeterministicRandom } from "./random.js";
import { validateScenario } from "./scenario.js";
import { TraceRecorder } from "./trace.js";
import type {
  ActionStep,
  AdapterClient,
  AssertionResult,
  ClientResult,
  FailureArtifact,
  JsonObject,
  JsonValue,
  NetworkConfig,
  Operation,
  ResourceLimits,
  RunOptions,
  RunReport,
  RunStatus,
  Scenario,
  ScenarioStep,
  SyncAdapter,
} from "./types.js";

export const TRACE_FORMAT = 1;

const DEFAULT_LIMITS: ResourceLimits = {
  maxEvents: 100_000,
  maxQueuedMessages: 25_000,
  maxPayloadBytes: 8 * 1024 * 1024,
  maxVirtualTimeMs: 24 * 60 * 60 * 1000,
};

function operationDetails(operation: Operation, traceValues: boolean): JsonValue {
  if (traceValues) return canonicalize(operation);
  const details: Record<string, JsonValue> = {
    type: operation.type,
    hash: hashValue(operation),
  };
  if ("path" in operation) details.path = operation.path;
  if (operation.type === "custom") details.name = operation.name;
  return details;
}

function contextFor(
  clientId: string,
  now: number,
  skew: number,
  random: DeterministicRandom,
) {
  const stream = random.stream(`adapter:${clientId}`);
  return {
    clientId,
    now: now + skew,
    random: () => stream.next("adapter"),
  } as const;
}

async function collectClients(clients: ReadonlyMap<string, AdapterClient>): Promise<ClientResult[]> {
  return Promise.all([...clients].sort(([left], [right]) => left.localeCompare(right)).map(async ([id, client]) => {
    const state = canonicalize(await client.snapshot());
    const metadata = canonicalize(await client.metadata());
    return {
      id,
      state,
      stateHash: hashValue(state),
      metadata,
      metadataHash: hashValue(metadata),
    };
  }));
}

function statusForError(error: unknown): RunStatus {
  if (error instanceof ScenarioValidationError) return "invalid";
  if (error instanceof ResourceLimitError) return "inconclusive";
  if (error instanceof SyncLabError && ["INVALID_PATH", "PATH_NOT_FOUND", "PATH_TYPE", "PATH_RANGE", "UNSUPPORTED_OPERATION", "INVALID_TIME", "INVALID_NETWORK"].includes(error.code)) {
    return "invalid";
  }
  return "harness-error";
}

function failureSignature(assertions: AssertionResult[], status: RunStatus, error?: string): string | undefined {
  const failure = assertions.find((assertion) => assertion.status === "fail");
  if (failure) return hashValue({ id: failure.id, type: failure.type, message: failure.message, details: failure.details ?? null });
  if (status !== "pass") return hashValue({ status, error: error ?? "unknown" });
  return undefined;
}

export async function runScenario(input: Scenario, options: RunOptions = {}): Promise<FailureArtifact> {
  const scenario = validateScenario(input);
  const seed = String(options.seed ?? scenario.seed ?? "1");
  const initial = structuredClone(scenario.initial ?? {}) as JsonObject;
  const limits: ResourceLimits = { ...DEFAULT_LIMITS, ...scenario.limits };
  const random = new DeterministicRandom(seed);
  const trace = new TraceRecorder(options.onEvent);
  const assertions: AssertionResult[] = [];
  const clients = new Map<string, AdapterClient>();
  const clockSkews = new Map<string, number>();
  let adapter: SyncAdapter | undefined;
  let status: RunStatus = "pass";
  let caughtError: string | undefined;
  let network!: SimulatedNetwork;

  const clientContext = (clientId: string) => contextFor(
    clientId,
    network?.now ?? 0,
    clockSkews.get(clientId) ?? 0,
    random,
  );

  const allClientIds = () => [...clients.keys()].sort();

  try {
    const factory = options.adapter ?? await resolveAdapter(scenario.adapter, options.baseDirectory);
    const adapterOptions = typeof scenario.adapter === "object" ? scenario.adapter.options ?? {} : {};
    adapter = await factory.create({ initial, seed, options: adapterOptions });
    for (const id of [...scenario.clients].sort()) {
      const client = await adapter.createClient(id);
      clients.set(id, client);
      clockSkews.set(id, 0);
      trace.emit(0, "client.started", { client: id, details: { adapter: adapter.name } });
    }

    network = new SimulatedNetwork({
      ...(scenario.network === undefined ? {} : { config: scenario.network }),
      random,
      trace,
      limits,
      deliver: async (envelope) => {
        const target = clients.get(envelope.to);
        if (!target) throw new SyncLabError("UNKNOWN_CLIENT", `Unknown message target ${envelope.to}`);
        await target.receive(envelope.payload, clientContext(envelope.to));
      },
    });

    trace.emit(0, "run.started", {
      details: {
        scenario: scenario.name,
        seed,
        adapter: adapter.name,
        adapterVersion: adapter.version,
      },
    });

    const mutate = async (action: ActionStep["action"], broadcast: boolean): Promise<{ client: string; update: Uint8Array }> => {
      const client = clients.get(action.client)!;
      const result = await client.mutate(action.operation, clientContext(action.client));
      trace.emit(network.now, "operation.applied", {
        client: action.client,
        details: {
          operationId: result.operationId,
          durability: result.durability,
          operation: operationDetails(action.operation, options.traceValues ?? false),
          updateHash: hashValue(result.update),
          updateBytes: result.update.byteLength,
        },
      });
      if (result.durability === "rejected") throw new SyncLabError("OPERATION_REJECTED", `Adapter rejected operation ${result.operationId}`);
      if (broadcast) network.broadcast(action.client, allClientIds(), result.update, "delta");
      return { client: action.client, update: result.update };
    };

    const sync = async (selected?: string[]): Promise<void> => {
      const selectedIds = [...(selected ?? allClientIds())].sort();
      const pairs = new Set<string>();
      for (const source of selectedIds) {
        for (const target of allClientIds()) {
          if (source !== target) pairs.add(`${source}\u0000${target}`);
        }
      }
      if (selected !== undefined) {
        for (const source of allClientIds()) {
          for (const target of selectedIds) {
            if (source !== target) pairs.add(`${source}\u0000${target}`);
          }
        }
      }
      const states = new Map<string, Uint8Array>();
      for (const pair of [...pairs].sort()) {
        const [source, target] = pair.split("\u0000") as [string, string];
        let state = states.get(source);
        if (!state) {
          state = await clients.get(source)!.exportState();
          states.set(source, state);
        }
        network.send(source, target, state, "sync");
      }
      trace.emit(network.now, "sync.requested", { details: { clients: selectedIds } });
    };

    const executeSteps = async (steps: ScenarioStep[], prefix: string): Promise<void> => {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        const stepId = `${prefix}${index + 1}`;
        trace.emit(network.now, "step.started", { message: stepId, details: { kind: Object.keys(step)[0]! } });
        if ("action" in step) {
          await mutate(step.action, true);
        } else if ("parallel" in step) {
          const results = [];
          for (const action of step.parallel) results.push(await mutate(action, false));
          for (const result of results) network.broadcast(result.client, allClientIds(), result.update, "delta");
        } else if ("partition" in step) {
          network.partition(step.partition.groups);
        } else if ("heal" in step) {
          const selected = step.heal === true ? undefined : step.heal.clients;
          network.heal(selected);
          await sync(selected);
        } else if ("network" in step) {
          const { from, to, ...config } = step.network;
          network.configure(config, from, to);
        } else if ("tick" in step) {
          await network.advance(typeof step.tick === "number" ? step.tick : step.tick.ms);
        } else if ("settle" in step) {
          await network.settle(step.settle === true ? undefined : step.settle.maxEvents);
        } else if ("sync" in step) {
          await sync(step.sync === true ? undefined : step.sync.clients);
        } else if ("restart" in step) {
          const value = typeof step.restart === "string" ? { client: step.restart, resync: true } : { resync: true, ...step.restart };
          await clients.get(value.client)!.restart();
          trace.emit(network.now, "client.restarted", { client: value.client });
          if (value.resync) await sync([value.client]);
        } else if ("reset" in step) {
          const value = typeof step.reset === "string" ? { client: step.reset, resync: true } : { resync: true, ...step.reset };
          await clients.get(value.client)!.reset();
          trace.emit(network.now, "client.storage-reset", { client: value.client });
          if (value.resync) await sync([value.client]);
        } else if ("clock" in step) {
          clockSkews.set(step.clock.client, step.clock.skewMs);
          trace.emit(network.now, "client.clock-skewed", { client: step.clock.client, details: { skewMs: step.clock.skewMs } });
        } else if ("checkpoint" in step) {
          const states = options.traceValues ? await collectClients(clients) : undefined;
          trace.checkpoint(network.now, step.checkpoint, states === undefined ? undefined : canonicalize(states));
        } else if ("repeat" in step) {
          for (let repeat = 0; repeat < step.repeat.times; repeat += 1) {
            await executeSteps(step.repeat.steps, `${stepId}.${repeat + 1}.`);
          }
        } else if ("assert" in step) {
          const result = await evaluateAssertion({
            at: network.now,
            assertion: step.assert,
            clients,
            queuedMessages: network.queuedMessages,
            fallbackId: `assert-${stepId}`,
          });
          assertions.push(result);
          trace.emit(network.now, `assertion.${result.status}`, {
            message: result.message,
            details: { id: result.id, type: result.type, ...(result.details === undefined ? {} : { details: result.details }) },
          });
          if (result.status === "fail") status = "fail";
        }
        trace.emit(network.now, "step.completed", { message: stepId });
      }
    };

    await executeSteps(scenario.steps, "");
  } catch (error) {
    status = statusForError(error);
    caughtError = errorMessage(error);
    trace.emit(network?.now ?? 0, "run.error", {
      message: caughtError,
      details: { status, code: error instanceof SyncLabError ? error.code : "UNEXPECTED" },
    });
  }

  let clientResults: ClientResult[] = [];
  try {
    clientResults = await collectClients(clients);
  } catch (error) {
    if (status === "pass" || status === "fail") {
      status = "harness-error";
      caughtError = `Could not collect final snapshots: ${errorMessage(error)}`;
      trace.emit(network?.now ?? 0, "run.error", {
        message: caughtError,
        details: { status, code: "SNAPSHOT_FAILED" },
      });
    }
  }

  try {
    await adapter?.dispose();
  } catch (error) {
    status = "harness-error";
    caughtError = `Adapter disposal failed: ${errorMessage(error)}`;
    trace.emit(network?.now ?? 0, "run.error", {
      message: caughtError,
      details: { status, code: "DISPOSE_FAILED" },
    });
  }

  const signature = failureSignature(assertions, status, caughtError);
  trace.emit(network?.now ?? 0, "run.completed", {
    details: {
      status,
      assertions: assertions.length,
      failures: assertions.filter((assertion) => assertion.status === "fail").length,
      failureSignature: signature ?? null,
    },
  });
  const fingerprint = trace.fingerprint(canonicalize({
    decisions: random.decisions,
    clients: clientResults.map(({ id, stateHash, metadataHash }) => ({ id, stateHash, metadataHash })),
    assertions,
    outcome: { status, failureSignature: signature ?? null, error: caughtError ?? null },
  }));
  const environment = {
    synclab: SYNCLAB_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    adapter: adapter?.name ?? (typeof scenario.adapter === "string" ? scenario.adapter : scenario.adapter.module),
    adapterVersion: adapter?.version ?? "unknown",
    scenarioFormat: 1,
    traceFormat: TRACE_FORMAT,
    canonicalFormat: CANONICAL_FORMAT,
    prng: DeterministicRandom.algorithm,
  };
  const reportBase = {
    status,
    scenario: scenario.name,
    seed,
    virtualTimeMs: network?.now ?? 0,
    processedEvents: network?.processedEvents ?? 0,
    queuedMessages: network?.queuedMessages ?? 0,
    assertions,
    clients: clientResults,
    traceFingerprint: fingerprint,
    environment,
  };
  const report: RunReport = {
    ...reportBase,
    ...(signature === undefined ? {} : { failureSignature: signature }),
    ...(caughtError === undefined ? {} : { error: caughtError }),
  };

  return {
    format: 1,
    scenario,
    seed,
    report,
    events: trace.events,
    decisions: random.decisions,
  };
}

export async function runScenarioReport(scenario: Scenario, options: RunOptions = {}): Promise<RunReport> {
  return (await runScenario(scenario, options)).report;
}
