import { readFile } from "node:fs/promises";
import { extname, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { ScenarioValidationError } from "./errors.js";
import type {
  Assertion,
  JsonObject,
  JsonPath,
  JsonValue,
  NetworkConfig,
  Operation,
  Scenario,
  ScenarioStep,
} from "./types.js";

const MAX_SCENARIO_BYTES = 1_048_576;
const CLIENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOP_LEVEL_KEYS = new Set(["version", "name", "description", "adapter", "seed", "clients", "initial", "network", "limits", "steps"]);
const STEP_KEYS = new Set(["action", "parallel", "partition", "heal", "network", "tick", "settle", "sync", "restart", "reset", "clock", "checkpoint", "repeat", "assert"]);

export interface LoadedScenario {
  scenario: Scenario;
  path: string;
  baseDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, at: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${at} contains unknown key \"${key}\"`);
  }
}

function isJson(value: unknown, at: string, issues: string[], seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(`${at} must not contain non-finite numbers`);
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      issues.push(`${at} must not contain cycles`);
      return false;
    }
    seen.add(value);
    const valid = value.every((entry, index) => isJson(entry, `${at}[${index}]`, issues, seen));
    seen.delete(value);
    return valid;
  }
  if (isRecord(value)) {
    if (seen.has(value)) {
      issues.push(`${at} must not contain cycles`);
      return false;
    }
    seen.add(value);
    const valid = Object.entries(value).every(([key, entry]) => isJson(entry, `${at}.${key}`, issues, seen));
    seen.delete(value);
    return valid;
  }
  issues.push(`${at} must be JSON-compatible`);
  return false;
}

function validatePath(value: unknown, at: string, issues: string[]): value is JsonPath {
  if (!Array.isArray(value)) {
    issues.push(`${at} must be an array of string or non-negative integer segments`);
    return false;
  }
  if (value.length === 0) issues.push(`${at} must not be empty`);
  for (const [index, segment] of value.entries()) {
    if (typeof segment !== "string" && (!Number.isSafeInteger(segment) || (segment as number) < 0)) {
      issues.push(`${at}[${index}] must be a string or non-negative safe integer`);
    }
  }
  return true;
}

function validateOperation(value: unknown, at: string, issues: string[]): value is Operation {
  if (!isRecord(value) || typeof value.type !== "string") {
    issues.push(`${at} must be an operation object with a type`);
    return false;
  }
  const commonPath = () => validatePath(value.path, `${at}.path`, issues);
  switch (value.type) {
    case "set":
      addUnknownKeys(value, new Set(["type", "path", "value"]), at, issues);
      commonPath();
      if (!("value" in value)) issues.push(`${at}.value is required`);
      else isJson(value.value, `${at}.value`, issues);
      return true;
    case "delete":
      addUnknownKeys(value, new Set(["type", "path"]), at, issues);
      commonPath();
      return true;
    case "increment":
      addUnknownKeys(value, new Set(["type", "path", "by"]), at, issues);
      commonPath();
      if (value.by !== undefined && (typeof value.by !== "number" || !Number.isFinite(value.by))) issues.push(`${at}.by must be a finite number`);
      return true;
    case "list-insert":
      addUnknownKeys(value, new Set(["type", "path", "index", "values"]), at, issues);
      commonPath();
      if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) issues.push(`${at}.index must be a non-negative safe integer`);
      if (!Array.isArray(value.values)) issues.push(`${at}.values must be an array`);
      else value.values.forEach((entry, index) => isJson(entry, `${at}.values[${index}]`, issues));
      return true;
    case "list-delete":
      addUnknownKeys(value, new Set(["type", "path", "index", "count"]), at, issues);
      commonPath();
      if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) issues.push(`${at}.index must be a non-negative safe integer`);
      if (value.count !== undefined && (!Number.isSafeInteger(value.count) || (value.count as number) < 1)) issues.push(`${at}.count must be a positive safe integer`);
      return true;
    case "text-insert":
      addUnknownKeys(value, new Set(["type", "path", "index", "text"]), at, issues);
      commonPath();
      if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) issues.push(`${at}.index must be a non-negative safe integer`);
      if (typeof value.text !== "string") issues.push(`${at}.text must be a string`);
      return true;
    case "text-delete":
      addUnknownKeys(value, new Set(["type", "path", "index", "count"]), at, issues);
      commonPath();
      if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) issues.push(`${at}.index must be a non-negative safe integer`);
      if (!Number.isSafeInteger(value.count) || (value.count as number) < 1) issues.push(`${at}.count must be a positive safe integer`);
      return true;
    case "merge":
      addUnknownKeys(value, new Set(["type", "path", "value"]), at, issues);
      commonPath();
      if (!isRecord(value.value) || !isJson(value.value, `${at}.value`, issues)) issues.push(`${at}.value must be a JSON object`);
      return true;
    case "custom":
      addUnknownKeys(value, new Set(["type", "name", "input"]), at, issues);
      if (typeof value.name !== "string" || value.name.length === 0) issues.push(`${at}.name must be a non-empty string`);
      if (value.input !== undefined) isJson(value.input, `${at}.input`, issues);
      return true;
    default:
      issues.push(`${at}.type \"${value.type}\" is not supported`);
      return false;
  }
}

function validateNetwork(value: unknown, at: string, issues: string[], allowLinks: boolean): value is Partial<NetworkConfig> {
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`);
    return false;
  }
  addUnknownKeys(value, new Set(["latencyMs", "dropRate", "duplicateRate", "reorderRate", "reorderWindowMs", ...(allowLinks ? ["from", "to"] : [])]), at, issues);
  const latency = value.latencyMs;
  if (latency !== undefined) {
    if (typeof latency === "number") {
      if (!Number.isFinite(latency) || latency < 0) issues.push(`${at}.latencyMs must be non-negative`);
    } else if (isRecord(latency)) {
      addUnknownKeys(latency, new Set(["min", "max"]), `${at}.latencyMs`, issues);
      if (typeof latency.min !== "number" || typeof latency.max !== "number" || latency.min < 0 || latency.max < latency.min) {
        issues.push(`${at}.latencyMs must have a valid non-negative min/max range`);
      }
    } else issues.push(`${at}.latencyMs must be a number or min/max object`);
  }
  for (const field of ["dropRate", "duplicateRate", "reorderRate"] as const) {
    const entry = value[field];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1)) {
      issues.push(`${at}.${field} must be between 0 and 1`);
    }
  }
  if (value.reorderWindowMs !== undefined && (typeof value.reorderWindowMs !== "number" || !Number.isFinite(value.reorderWindowMs) || value.reorderWindowMs < 0)) {
    issues.push(`${at}.reorderWindowMs must be non-negative`);
  }
  return true;
}

function validateAssertion(value: unknown, at: string, clients: Set<string>, issues: string[]): value is Assertion {
  if (!isRecord(value) || typeof value.type !== "string") {
    issues.push(`${at} must be an assertion object with a type`);
    return false;
  }
  const validateClient = (entry: unknown, label: string) => {
    if (typeof entry !== "string" || !clients.has(entry)) issues.push(`${label} must name a configured client`);
  };
  const validateClients = (entry: unknown, label: string) => {
    if (entry !== undefined && (!Array.isArray(entry) || entry.length === 0 || entry.some((id) => typeof id !== "string" || !clients.has(id)))) {
      issues.push(`${label} must be a non-empty array of configured client IDs`);
    }
  };
  switch (value.type) {
    case "converged":
      addUnknownKeys(value, new Set(["type", "id", "clients", "compareMetadata"]), at, issues);
      validateClients(value.clients, `${at}.clients`);
      if (value.compareMetadata !== undefined && typeof value.compareMetadata !== "boolean") issues.push(`${at}.compareMetadata must be boolean`);
      return true;
    case "equals":
    case "not-equals":
      addUnknownKeys(value, new Set(["type", "id", "client", "path", "value"]), at, issues);
      validateClient(value.client, `${at}.client`);
      if (value.path !== undefined) validatePath(value.path, `${at}.path`, issues);
      if (!("value" in value)) issues.push(`${at}.value is required`);
      else isJson(value.value, `${at}.value`, issues);
      return true;
    case "all-equal":
      addUnknownKeys(value, new Set(["type", "id", "clients", "path", "value"]), at, issues);
      validateClients(value.clients, `${at}.clients`);
      validatePath(value.path, `${at}.path`, issues);
      if (!("value" in value)) issues.push(`${at}.value is required`);
      else isJson(value.value, `${at}.value`, issues);
      return true;
    case "contains":
      addUnknownKeys(value, new Set(["type", "id", "client", "path", "value"]), at, issues);
      validateClient(value.client, `${at}.client`);
      validatePath(value.path, `${at}.path`, issues);
      if (!("value" in value)) issues.push(`${at}.value is required`);
      else isJson(value.value, `${at}.value`, issues);
      return true;
    case "length":
      addUnknownKeys(value, new Set(["type", "id", "client", "path", "value"]), at, issues);
      validateClient(value.client, `${at}.client`);
      validatePath(value.path, `${at}.path`, issues);
      if (!Number.isSafeInteger(value.value) || (value.value as number) < 0) issues.push(`${at}.value must be a non-negative safe integer`);
      return true;
    case "no-pending":
      addUnknownKeys(value, new Set(["type", "id"]), at, issues);
      return true;
    default:
      issues.push(`${at}.type \"${value.type}\" is not supported`);
      return false;
  }
}

function validateSteps(values: unknown, at: string, clients: Set<string>, issues: string[]): values is ScenarioStep[] {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(`${at} must be a non-empty array`);
    return false;
  }
  const validateClient = (value: unknown, label: string) => {
    if (typeof value !== "string" || !clients.has(value)) issues.push(`${label} must name a configured client`);
  };
  for (const [index, entry] of values.entries()) {
    const label = `${at}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1 || !STEP_KEYS.has(keys[0]!)) {
      issues.push(`${label} must contain exactly one supported step key`);
      continue;
    }
    const kind = keys[0]!;
    const value = entry[kind];
    switch (kind) {
      case "action":
        if (!isRecord(value)) issues.push(`${label}.action must be an object`);
        else {
          addUnknownKeys(value, new Set(["client", "operation"]), `${label}.action`, issues);
          validateClient(value.client, `${label}.action.client`);
          validateOperation(value.operation, `${label}.action.operation`, issues);
        }
        break;
      case "parallel":
        if (!Array.isArray(value) || value.length === 0) issues.push(`${label}.parallel must be a non-empty array`);
        else value.forEach((action, actionIndex) => {
          const actionLabel = `${label}.parallel[${actionIndex}]`;
          if (!isRecord(action)) issues.push(`${actionLabel} must be an object`);
          else {
            addUnknownKeys(action, new Set(["client", "operation"]), actionLabel, issues);
            validateClient(action.client, `${actionLabel}.client`);
            validateOperation(action.operation, `${actionLabel}.operation`, issues);
          }
        });
        break;
      case "partition":
        if (!isRecord(value) || !Array.isArray(value.groups)) issues.push(`${label}.partition.groups must be an array of client groups`);
        else {
          addUnknownKeys(value, new Set(["groups"]), `${label}.partition`, issues);
          const listed: string[] = [];
          value.groups.forEach((group, groupIndex) => {
            if (!Array.isArray(group) || group.length === 0) issues.push(`${label}.partition.groups[${groupIndex}] must be non-empty`);
            else group.forEach((client) => {
              validateClient(client, `${label}.partition.groups[${groupIndex}]`);
              if (typeof client === "string") listed.push(client);
            });
          });
          if (listed.length !== clients.size || new Set(listed).size !== clients.size) issues.push(`${label}.partition.groups must contain every client exactly once`);
        }
        break;
      case "heal":
        if (value !== true && !isRecord(value)) issues.push(`${label}.heal must be true or an object`);
        else if (isRecord(value)) {
          addUnknownKeys(value, new Set(["clients"]), `${label}.heal`, issues);
          if (value.clients !== undefined && (!Array.isArray(value.clients) || value.clients.some((client) => typeof client !== "string" || !clients.has(client)))) issues.push(`${label}.heal.clients must list configured clients`);
        }
        break;
      case "network":
        validateNetwork(value, `${label}.network`, issues, true);
        if (isRecord(value)) {
          const from = value.from;
          const to = value.to;
          if ((from === undefined) !== (to === undefined)) issues.push(`${label}.network requires both from and to for link overrides`);
          if (from !== undefined) validateClient(from, `${label}.network.from`);
          if (to !== undefined) validateClient(to, `${label}.network.to`);
        }
        break;
      case "tick": {
        const ms = typeof value === "number" ? value : isRecord(value) ? value.ms : undefined;
        if (isRecord(value)) addUnknownKeys(value, new Set(["ms"]), `${label}.tick`, issues);
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) issues.push(`${label}.tick must be a non-negative number or { ms }`);
        break;
      }
      case "settle":
        if (value !== true && !isRecord(value)) issues.push(`${label}.settle must be true or an object`);
        else if (isRecord(value)) {
          addUnknownKeys(value, new Set(["maxEvents"]), `${label}.settle`, issues);
          if (value.maxEvents !== undefined && (!Number.isSafeInteger(value.maxEvents) || (value.maxEvents as number) < 1)) issues.push(`${label}.settle.maxEvents must be positive`);
        }
        break;
      case "sync":
        if (value !== true && !isRecord(value)) issues.push(`${label}.sync must be true or an object`);
        else if (isRecord(value)) {
          addUnknownKeys(value, new Set(["clients"]), `${label}.sync`, issues);
          if (value.clients !== undefined && (!Array.isArray(value.clients) || value.clients.length === 0 || value.clients.some((client) => typeof client !== "string" || !clients.has(client)))) issues.push(`${label}.sync.clients must list configured clients`);
        }
        break;
      case "restart":
      case "reset":
        if (typeof value === "string") validateClient(value, `${label}.${kind}`);
        else if (!isRecord(value)) issues.push(`${label}.${kind} must be a client ID or object`);
        else {
          addUnknownKeys(value, new Set(["client", "resync"]), `${label}.${kind}`, issues);
          validateClient(value.client, `${label}.${kind}.client`);
          if (value.resync !== undefined && typeof value.resync !== "boolean") issues.push(`${label}.${kind}.resync must be boolean`);
        }
        break;
      case "clock":
        if (!isRecord(value)) issues.push(`${label}.clock must be an object`);
        else {
          addUnknownKeys(value, new Set(["client", "skewMs"]), `${label}.clock`, issues);
          validateClient(value.client, `${label}.clock.client`);
          if (typeof value.skewMs !== "number" || !Number.isFinite(value.skewMs)) issues.push(`${label}.clock.skewMs must be finite`);
        }
        break;
      case "checkpoint":
        if (typeof value !== "string" || value.length === 0) issues.push(`${label}.checkpoint must be a non-empty string`);
        break;
      case "repeat":
        if (!isRecord(value)) issues.push(`${label}.repeat must be an object`);
        else {
          addUnknownKeys(value, new Set(["times", "steps"]), `${label}.repeat`, issues);
          if (!Number.isSafeInteger(value.times) || (value.times as number) < 1 || (value.times as number) > 10_000) issues.push(`${label}.repeat.times must be between 1 and 10000`);
          validateSteps(value.steps, `${label}.repeat.steps`, clients, issues);
        }
        break;
      case "assert":
        validateAssertion(value, `${label}.assert`, clients, issues);
        break;
    }
  }
  return true;
}

export function validateScenario(value: unknown): Scenario {
  const issues: string[] = [];
  if (!isRecord(value)) throw new ScenarioValidationError(["Scenario must be an object"]);
  addUnknownKeys(value, TOP_LEVEL_KEYS, "scenario", issues);
  if (value.version !== 1) issues.push("scenario.version must be 1");
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > 200) issues.push("scenario.name must be 1-200 characters");
  if (value.description !== undefined && typeof value.description !== "string") issues.push("scenario.description must be a string");
  if (typeof value.adapter === "string") {
    if (!new Set(["reference", "yjs", "automerge"]).has(value.adapter)) issues.push("scenario.adapter must be reference, yjs, automerge, or a module spec");
  } else if (isRecord(value.adapter)) {
    addUnknownKeys(value.adapter, new Set(["module", "options"]), "scenario.adapter", issues);
    if (typeof value.adapter.module !== "string" || value.adapter.module.length === 0) issues.push("scenario.adapter.module must be a non-empty path");
    if (value.adapter.options !== undefined && (!isRecord(value.adapter.options) || !isJson(value.adapter.options, "scenario.adapter.options", issues))) issues.push("scenario.adapter.options must be a JSON object");
  } else issues.push("scenario.adapter is required");
  if (value.seed !== undefined && typeof value.seed !== "string" && typeof value.seed !== "number") issues.push("scenario.seed must be a string or number");
  if (!Array.isArray(value.clients) || value.clients.length < 1 || value.clients.length > 100) issues.push("scenario.clients must contain 1-100 client IDs");
  const clientValues = Array.isArray(value.clients) ? value.clients : [];
  for (const client of clientValues) {
    if (typeof client !== "string" || !CLIENT_ID.test(client)) issues.push(`Invalid client ID ${JSON.stringify(client)}`);
  }
  const clientIds = new Set(clientValues.filter((entry): entry is string => typeof entry === "string"));
  if (clientIds.size !== clientValues.length) issues.push("scenario.clients must not contain duplicates");
  if (value.initial !== undefined && (!isRecord(value.initial) || !isJson(value.initial, "scenario.initial", issues))) issues.push("scenario.initial must be a JSON object");
  if (value.network !== undefined) validateNetwork(value.network, "scenario.network", issues, false);
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) issues.push("scenario.limits must be an object");
    else {
      addUnknownKeys(value.limits, new Set(["maxEvents", "maxQueuedMessages", "maxPayloadBytes", "maxVirtualTimeMs"]), "scenario.limits", issues);
      for (const field of ["maxEvents", "maxQueuedMessages", "maxPayloadBytes", "maxVirtualTimeMs"] as const) {
        const entry = value.limits[field];
        if (entry !== undefined && (!Number.isSafeInteger(entry) || (entry as number) < 1)) issues.push(`scenario.limits.${field} must be a positive safe integer`);
      }
    }
  }
  validateSteps(value.steps, "scenario.steps", clientIds, issues);
  if (issues.length > 0) throw new ScenarioValidationError(issues);
  return structuredClone(value) as unknown as Scenario;
}

export function defineScenario<const T extends Scenario>(scenario: T): T {
  validateScenario(scenario);
  return scenario;
}

export async function loadScenario(filePath: string): Promise<LoadedScenario> {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const extension = extname(absolute).toLowerCase();
  let value: unknown;
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    const loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
    value = loaded.default ?? loaded.scenario;
  } else {
    const source = await readFile(absolute);
    if (source.byteLength > MAX_SCENARIO_BYTES) throw new ScenarioValidationError([`Scenario exceeds ${MAX_SCENARIO_BYTES} bytes`]);
    const text = source.toString("utf8");
    if (extension === ".yaml" || extension === ".yml") value = parseYaml(text, { merge: false, uniqueKeys: true });
    else if (extension === ".json") value = JSON.parse(text) as unknown;
    else throw new ScenarioValidationError(["Scenario file must use .json, .yaml, .yml, .js, .mjs, or .cjs"]);
  }
  return { scenario: validateScenario(value), path: absolute, baseDirectory: dirname(absolute) };
}
