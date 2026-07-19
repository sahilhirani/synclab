import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import * as A from "@automerge/automerge";
import { canonicalize, hashValue } from "../core/canonical.js";
import { SyncLabError } from "../core/errors.js";
import type {
  AdapterClient,
  AdapterContext,
  AdapterCreateOptions,
  AdapterFactory,
  JsonObject,
  JsonPath,
  JsonValue,
  MutationResult,
  Operation,
  SyncAdapter,
} from "../core/types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function actorId(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}\u0000${id}`).digest("hex");
}

function encodeChanges(changes: Uint8Array[]): Uint8Array {
  return encoder.encode(JSON.stringify(changes.map((change) => Buffer.from(change).toString("base64"))));
}

function decodeChanges(update: Uint8Array): Uint8Array[] {
  const values = JSON.parse(decoder.decode(update)) as unknown;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new TypeError("Invalid Automerge update packet");
  }
  return values.map((value) => new Uint8Array(Buffer.from(value as string, "base64")));
}

function childAt(container: unknown, segment: string | number): unknown {
  if (container === null || typeof container !== "object") throw new SyncLabError("PATH_TYPE", "Cannot traverse Automerge scalar");
  return (container as Record<string | number, unknown>)[segment];
}

function atPath(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const segment of path) current = childAt(current, segment);
  return current;
}

function parentAtPath(root: unknown, path: JsonPath): { parent: Record<string | number, unknown>; key: string | number } {
  if (path.length === 0) throw new SyncLabError("INVALID_PATH", "Operation paths cannot target the document root");
  const parent = atPath(root, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") throw new SyncLabError("PATH_TYPE", "Automerge operation parent is not a container");
  return { parent: parent as Record<string | number, unknown>, key: path[path.length - 1]! };
}

function mutateAutomerge(root: unknown, operation: Operation): void {
  switch (operation.type) {
    case "set": {
      const { parent, key } = parentAtPath(root, operation.path);
      if (Array.isArray(parent)) {
        if (typeof key !== "number" || key < 0 || key >= parent.length) throw new SyncLabError("PATH_RANGE", "Automerge list index is out of range");
        parent[key] = structuredClone(operation.value);
      } else {
        parent[key] = structuredClone(operation.value);
      }
      return;
    }
    case "delete": {
      const { parent, key } = parentAtPath(root, operation.path);
      if (Array.isArray(parent) && typeof key === "number") {
        if (key < 0 || key >= parent.length) throw new SyncLabError("PATH_RANGE", "Automerge list index is out of range");
        A.deleteAt(parent, key);
      }
      else delete parent[key];
      return;
    }
    case "increment": {
      const current = atPath(root, operation.path);
      if (typeof current !== "number") throw new SyncLabError("PATH_TYPE", "Automerge increment target is not a number");
      const { parent, key } = parentAtPath(root, operation.path);
      parent[key] = current + (operation.by ?? 1);
      return;
    }
    case "list-insert": {
      const list = atPath(root, operation.path);
      if (!Array.isArray(list)) throw new SyncLabError("PATH_TYPE", "Automerge list operation target is not a list");
      if (operation.index < 0 || operation.index > list.length) throw new SyncLabError("PATH_RANGE", "Automerge list insertion index is out of range");
      A.insertAt(list, operation.index, ...structuredClone(operation.values));
      return;
    }
    case "list-delete": {
      const list = atPath(root, operation.path);
      if (!Array.isArray(list)) throw new SyncLabError("PATH_TYPE", "Automerge list operation target is not a list");
      const count = operation.count ?? 1;
      if (operation.index < 0 || operation.index + count > list.length) throw new SyncLabError("PATH_RANGE", "Automerge list deletion range is out of bounds");
      A.deleteAt(list, operation.index, count);
      return;
    }
    case "text-insert": {
      const text = atPath(root, operation.path);
      if (typeof text !== "string") throw new SyncLabError("PATH_TYPE", "Automerge text operation target is not text");
      if (operation.index < 0 || operation.index > text.length) throw new SyncLabError("PATH_RANGE", "Automerge text insertion index is out of range");
      A.splice(root as Record<string, unknown>, operation.path, operation.index, 0, operation.text);
      return;
    }
    case "text-delete": {
      const text = atPath(root, operation.path);
      if (typeof text !== "string") throw new SyncLabError("PATH_TYPE", "Automerge text operation target is not text");
      if (operation.index < 0 || operation.index + operation.count > text.length) throw new SyncLabError("PATH_RANGE", "Automerge text deletion range is out of bounds");
      A.splice(root as Record<string, unknown>, operation.path, operation.index, operation.count, "");
      return;
    }
    case "merge": {
      const map = atPath(root, operation.path);
      if (map === null || typeof map !== "object" || Array.isArray(map)) throw new SyncLabError("PATH_TYPE", "Automerge merge target is not a map");
      for (const [key, value] of Object.entries(operation.value)) (map as Record<string, unknown>)[key] = structuredClone(value);
      return;
    }
    case "custom":
      throw new SyncLabError("UNSUPPORTED_OPERATION", "The Automerge adapter does not support custom operations");
  }
}

class AutomergeClient implements AdapterClient {
  readonly id: string;
  readonly #seed: string;
  #actor: string;
  #doc: A.Doc<JsonObject>;
  #sequence = 0;
  #generation = 0;
  readonly #known = new Set<string>();
  readonly #pending = new Map<string, Uint8Array>();

  constructor(id: string, seed: string, baseline: Uint8Array) {
    this.id = id;
    this.#seed = seed;
    this.#actor = actorId(seed, `${id}#0`);
    this.#doc = A.load<JsonObject>(baseline, { actor: this.#actor });
    for (const change of A.getAllChanges(this.#doc)) this.#known.add(A.decodeChange(change).hash);
  }

  async mutate(operation: Operation): Promise<MutationResult> {
    const before = this.#doc;
    this.#doc = A.change(this.#doc, { message: `${this.id}:${this.#sequence}`, time: undefined }, (draft) => mutateAutomerge(draft, operation));
    const changes = A.getChanges(before, this.#doc);
    for (const change of changes) this.#known.add(A.decodeChange(change).hash);
    const update = encodeChanges(changes);
    const operationId = `${this.id}:${this.#sequence}:${hashValue(update).slice(0, 12)}`;
    this.#sequence += 1;
    return { update, operationId, durability: "durable" };
  }

  async receive(update: Uint8Array): Promise<void> {
    const changes = decodeChanges(update);
    for (const change of changes) {
      const decoded = A.decodeChange(change);
      if (!this.#known.has(decoded.hash)) this.#pending.set(decoded.hash, change);
    }
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [hash, change] of [...this.#pending].sort(([left], [right]) => left.localeCompare(right))) {
        const decoded = A.decodeChange(change);
        if (decoded.deps.every((dependency) => this.#known.has(dependency))) {
          [this.#doc] = A.applyChanges(this.#doc, [change]);
          this.#known.add(hash);
          this.#pending.delete(hash);
          progressed = true;
        }
      }
    }
  }

  async exportState(): Promise<Uint8Array> {
    return encodeChanges(A.getAllChanges(this.#doc));
  }

  async snapshot(): Promise<JsonValue> {
    return canonicalize(A.toJS(this.#doc));
  }

  async metadata(): Promise<JsonValue> {
    return { heads: [...A.getHeads(this.#doc)].sort(), pending: this.#pending.size };
  }

  async pending(): Promise<number> {
    return this.#pending.size;
  }

  async restart(): Promise<void> {
    const previous = this.#doc;
    this.#doc = A.load<JsonObject>(A.save(previous), { actor: this.#actor });
    A.free(previous);
  }

  async reset(): Promise<void> {
    const previous = this.#doc;
    this.#generation += 1;
    this.#actor = actorId(this.#seed, `${this.id}#${this.#generation}`);
    this.#doc = A.init<JsonObject>({ actor: this.#actor });
    A.free(previous);
    this.#sequence = 0;
    this.#known.clear();
    this.#pending.clear();
  }

  async dispose(): Promise<void> {
    A.free(this.#doc);
  }
}

class AutomergeAdapter implements SyncAdapter {
  readonly name = "automerge";
  readonly version = "3.3.2";
  readonly #seed: string;
  readonly #baseline: Uint8Array;
  readonly #clients = new Set<AdapterClient>();

  constructor(initial: JsonObject, seed: string) {
    this.#seed = seed;
    let baseline = A.init<JsonObject>({ actor: actorId(seed, "baseline") });
    baseline = A.change(baseline, { message: "synclab:init", time: undefined }, (draft) => {
      for (const key of Object.keys(initial).sort()) draft[key] = structuredClone(initial[key]!);
    });
    this.#baseline = A.save(baseline);
    A.free(baseline);
  }

  async createClient(id: string): Promise<AdapterClient> {
    const client = new AutomergeClient(id, this.#seed, this.#baseline);
    this.#clients.add(client);
    return client;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#clients].map((client) => client.dispose()));
    this.#clients.clear();
  }
}

export const automergeAdapter: AdapterFactory = {
  name: "automerge",
  version: "3.3.2",
  async create(options: AdapterCreateOptions): Promise<SyncAdapter> {
    return new AutomergeAdapter(options.initial, options.seed);
  },
};

export default automergeAdapter;
