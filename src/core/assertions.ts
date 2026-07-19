import { canonicalize, hashValue, jsonEqual } from "./canonical.js";
import { getAtPath } from "./path.js";
import type {
  AdapterClient,
  Assertion,
  AssertionResult,
  JsonValue,
} from "./types.js";

export interface AssertionContext {
  at: number;
  assertion: Assertion & { id?: string };
  clients: ReadonlyMap<string, AdapterClient>;
  queuedMessages: number;
  fallbackId: string;
}

function passed(id: string, type: Assertion["type"], at: number, message: string): AssertionResult {
  return { id, type, at, status: "pass", message };
}

function failed(id: string, type: Assertion["type"], at: number, message: string, details?: JsonValue): AssertionResult {
  return details === undefined
    ? { id, type, at, status: "fail", message }
    : { id, type, at, status: "fail", message, details };
}

function contains(actual: JsonValue | undefined, expected: JsonValue): boolean {
  if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((entry) => jsonEqual(entry, expected));
  if (actual !== null && actual !== undefined && typeof actual === "object" && !Array.isArray(actual)
    && expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    return Object.entries(expected).every(([key, value]) => key in actual && jsonEqual(actual[key], value));
  }
  return false;
}

async function snapshotOf(clients: ReadonlyMap<string, AdapterClient>, id: string): Promise<JsonValue> {
  const client = clients.get(id);
  if (!client) throw new Error(`Unknown client ${id}`);
  return canonicalize(await client.snapshot());
}

function selectedClients(assertion: { clients?: string[] }, clients: ReadonlyMap<string, AdapterClient>): string[] {
  return [...(assertion.clients ?? [...clients.keys()])].sort();
}

export async function evaluateAssertion(context: AssertionContext): Promise<AssertionResult> {
  const { assertion, clients, at } = context;
  const id = assertion.id ?? context.fallbackId;
  switch (assertion.type) {
    case "converged": {
      const ids = selectedClients(assertion, clients);
      const states = await Promise.all(ids.map(async (client) => ({ client, value: await snapshotOf(clients, client) })));
      const stateHashes = states.map(({ client, value }) => ({ client, hash: hashValue(value) }));
      const stateConverged = new Set(stateHashes.map(({ hash }) => hash)).size <= 1;
      let metadataHashes: Array<{ client: string; hash: string }> = [];
      let metadataConverged = true;
      if (assertion.compareMetadata ?? true) {
        metadataHashes = await Promise.all(ids.map(async (client) => ({
          client,
          hash: hashValue(await clients.get(client)!.metadata()),
        })));
        metadataConverged = new Set(metadataHashes.map(({ hash }) => hash)).size <= 1;
      }
      if (stateConverged && metadataConverged) return passed(id, assertion.type, at, `${ids.length} clients converged`);
      return failed(id, assertion.type, at, "Clients did not converge", {
        stateHashes,
        metadataHashes,
        states,
      });
    }
    case "equals":
    case "not-equals": {
      const state = await snapshotOf(clients, assertion.client);
      const actual = assertion.path === undefined ? state : getAtPath(state, assertion.path);
      const equal = jsonEqual(actual, assertion.value);
      const success = assertion.type === "equals" ? equal : !equal;
      if (success) return passed(id, assertion.type, at, `${assertion.client} satisfied ${assertion.type}`);
      return failed(id, assertion.type, at, `${assertion.client} failed ${assertion.type}`, {
        actual: actual ?? null,
        expected: assertion.value,
        path: assertion.path ?? [],
      });
    }
    case "all-equal": {
      const ids = selectedClients(assertion, clients);
      const actual = await Promise.all(ids.map(async (client) => ({
        client,
        value: getAtPath(await snapshotOf(clients, client), assertion.path) ?? null,
      })));
      if (actual.every(({ value }) => jsonEqual(value, assertion.value))) {
        return passed(id, assertion.type, at, `All ${ids.length} clients contain the expected value`);
      }
      return failed(id, assertion.type, at, "At least one client differs from the expected value", {
        expected: assertion.value,
        actual,
        path: assertion.path,
      });
    }
    case "contains": {
      const actual = getAtPath(await snapshotOf(clients, assertion.client), assertion.path);
      if (contains(actual, assertion.value)) return passed(id, assertion.type, at, `${assertion.client} contains the expected value`);
      return failed(id, assertion.type, at, `${assertion.client} does not contain the expected value`, {
        actual: actual ?? null,
        expected: assertion.value,
        path: assertion.path,
      });
    }
    case "length": {
      const actual = getAtPath(await snapshotOf(clients, assertion.client), assertion.path);
      const length = typeof actual === "string" || Array.isArray(actual) ? actual.length
        : actual !== null && actual !== undefined && typeof actual === "object" ? Object.keys(actual).length
          : undefined;
      if (length === assertion.value) return passed(id, assertion.type, at, `${assertion.client} has length ${length}`);
      return failed(id, assertion.type, at, `${assertion.client} has length ${String(length)}, expected ${assertion.value}`, {
        actual: length ?? null,
        expected: assertion.value,
        path: assertion.path,
      });
    }
    case "no-pending": {
      const pendingByClient = await Promise.all([...clients].sort(([left], [right]) => left.localeCompare(right)).map(async ([client, adapter]) => ({
        client,
        pending: await adapter.pending(),
      })));
      const pending = pendingByClient.reduce((total, entry) => total + entry.pending, 0) + context.queuedMessages;
      if (pending === 0) return passed(id, assertion.type, at, "No messages or adapter work are pending");
      return failed(id, assertion.type, at, `${pending} pending item(s) remain`, {
        network: context.queuedMessages,
        clients: pendingByClient,
      });
    }
  }
}
