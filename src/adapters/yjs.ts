import { createHash } from "node:crypto";
import * as Y from "yjs";
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

function clientNumber(seed: string, id: string): number {
  const digest = createHash("sha256").update(`${seed}\u0000${id}`).digest();
  const value = digest.readUInt32BE(0) >>> 0;
  return value === 0 ? 1 : value;
}

function toYValue(value: JsonValue): unknown {
  if (typeof value === "string") {
    const text = new Y.Text();
    text.insert(0, value);
    return text;
  }
  if (Array.isArray(value)) {
    const list = new Y.Array<unknown>();
    if (value.length > 0) list.insert(0, value.map(toYValue));
    return list;
  }
  if (value !== null && typeof value === "object") {
    const map = new Y.Map<unknown>();
    for (const key of Object.keys(value).sort()) map.set(key, toYValue(value[key]!));
    return map;
  }
  return value;
}

type YContainer = Y.Map<unknown> | Y.Array<unknown>;

function childAt(container: unknown, segment: string | number): unknown {
  if (container instanceof Y.Map && typeof segment === "string") return container.get(segment);
  if (container instanceof Y.Array && typeof segment === "number") return container.get(segment);
  throw new SyncLabError("PATH_TYPE", `Cannot traverse segment ${String(segment)} in Yjs document`);
}

function atPath(root: Y.Map<unknown>, path: JsonPath): unknown {
  let current: unknown = root;
  for (const segment of path) current = childAt(current, segment);
  return current;
}

function parentAtPath(root: Y.Map<unknown>, path: JsonPath): { parent: YContainer; key: string | number } {
  if (path.length === 0) throw new SyncLabError("INVALID_PATH", "Operation paths cannot target the document root");
  const parent = atPath(root, path.slice(0, -1));
  if (!(parent instanceof Y.Map) && !(parent instanceof Y.Array)) throw new SyncLabError("PATH_TYPE", "Yjs operation parent is not a container");
  return { parent, key: path[path.length - 1]! };
}

function mutateY(root: Y.Map<unknown>, operation: Operation): void {
  switch (operation.type) {
    case "set": {
      const { parent, key } = parentAtPath(root, operation.path);
      const value = toYValue(operation.value);
      if (parent instanceof Y.Map && typeof key === "string") parent.set(key, value);
      else if (parent instanceof Y.Array && typeof key === "number") {
        if (key < 0 || key >= parent.length) throw new SyncLabError("PATH_RANGE", "Yjs list index is out of range");
        parent.delete(key, 1);
        parent.insert(key, [value]);
      } else throw new SyncLabError("PATH_TYPE", "Yjs path segment type does not match its container");
      return;
    }
    case "delete": {
      const { parent, key } = parentAtPath(root, operation.path);
      if (parent instanceof Y.Map && typeof key === "string") parent.delete(key);
      else if (parent instanceof Y.Array && typeof key === "number") parent.delete(key, 1);
      else throw new SyncLabError("PATH_TYPE", "Yjs path segment type does not match its container");
      return;
    }
    case "increment": {
      const current = atPath(root, operation.path);
      if (typeof current !== "number") throw new SyncLabError("PATH_TYPE", "Yjs increment target is not a number");
      mutateY(root, { type: "set", path: operation.path, value: current + (operation.by ?? 1) });
      return;
    }
    case "list-insert": {
      const list = atPath(root, operation.path);
      if (!(list instanceof Y.Array)) throw new SyncLabError("PATH_TYPE", "Yjs list operation target is not an array");
      if (operation.index < 0 || operation.index > list.length) throw new SyncLabError("PATH_RANGE", "Yjs list insertion index is out of range");
      list.insert(operation.index, operation.values.map(toYValue));
      return;
    }
    case "list-delete": {
      const list = atPath(root, operation.path);
      if (!(list instanceof Y.Array)) throw new SyncLabError("PATH_TYPE", "Yjs list operation target is not an array");
      const count = operation.count ?? 1;
      if (operation.index < 0 || operation.index + count > list.length) throw new SyncLabError("PATH_RANGE", "Yjs list deletion range is out of bounds");
      list.delete(operation.index, count);
      return;
    }
    case "text-insert": {
      const text = atPath(root, operation.path);
      if (!(text instanceof Y.Text)) throw new SyncLabError("PATH_TYPE", "Yjs text operation target is not text");
      if (operation.index < 0 || operation.index > text.length) throw new SyncLabError("PATH_RANGE", "Yjs text insertion index is out of range");
      text.insert(operation.index, operation.text);
      return;
    }
    case "text-delete": {
      const text = atPath(root, operation.path);
      if (!(text instanceof Y.Text)) throw new SyncLabError("PATH_TYPE", "Yjs text operation target is not text");
      if (operation.index < 0 || operation.index + operation.count > text.length) throw new SyncLabError("PATH_RANGE", "Yjs text deletion range is out of bounds");
      text.delete(operation.index, operation.count);
      return;
    }
    case "merge": {
      const map = atPath(root, operation.path);
      if (!(map instanceof Y.Map)) throw new SyncLabError("PATH_TYPE", "Yjs merge target is not a map");
      for (const key of Object.keys(operation.value).sort()) map.set(key, toYValue(operation.value[key]!));
      return;
    }
    case "custom":
      throw new SyncLabError("UNSUPPORTED_OPERATION", "The Yjs adapter does not support custom operations");
  }
}

class YjsClient implements AdapterClient {
  readonly id: string;
  readonly #seed: string;
  readonly #baseline: Uint8Array;
  #doc: Y.Doc;
  #root: Y.Map<unknown>;
  #sequence = 0;
  #generation = 0;
  #session = 0;

  constructor(id: string, seed: string, baseline: Uint8Array) {
    this.id = id;
    this.#seed = seed;
    this.#baseline = baseline;
    this.#doc = this.#createDocument(true);
    this.#root = this.#doc.getMap("root");
  }

  #createDocument(includeBaseline: boolean): Y.Doc {
    const doc = new Y.Doc({ guid: `synclab:${this.id}`, gc: false });
    doc.clientID = clientNumber(this.#seed, `${this.id}#${this.#generation}:session:${this.#session}`);
    if (includeBaseline) Y.applyUpdate(doc, this.#baseline, "synclab:baseline");
    return doc;
  }

  async mutate(operation: Operation, context: AdapterContext): Promise<MutationResult> {
    const before = Y.encodeStateVector(this.#doc);
    this.#doc.transact(() => mutateY(this.#root, operation), `synclab:local:${this.id}`);
    const update = Y.encodeStateAsUpdate(this.#doc, before);
    const operationId = `${this.id}:${this.#sequence}:${hashValue(update).slice(0, 12)}`;
    this.#sequence += 1;
    return { update, operationId, durability: "durable" };
  }

  async receive(update: Uint8Array): Promise<void> {
    Y.applyUpdate(this.#doc, update, "synclab:remote");
  }

  async exportState(): Promise<Uint8Array> {
    return Y.encodeStateAsUpdate(this.#doc);
  }

  async snapshot(): Promise<JsonValue> {
    return canonicalize(this.#root.toJSON());
  }

  async metadata(): Promise<JsonValue> {
    return { stateVector: Buffer.from(Y.encodeStateVector(this.#doc)).toString("base64") };
  }

  async pending(): Promise<number> {
    return 0;
  }

  async restart(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.#doc);
    this.#doc.destroy();
    this.#session += 1;
    this.#doc = this.#createDocument(false);
    Y.applyUpdate(this.#doc, state, "synclab:restart");
    this.#root = this.#doc.getMap("root");
  }

  async reset(): Promise<void> {
    this.#doc.destroy();
    this.#generation += 1;
    this.#session = 0;
    this.#doc = this.#createDocument(false);
    this.#root = this.#doc.getMap("root");
    this.#sequence = 0;
  }

  async dispose(): Promise<void> {
    this.#doc.destroy();
  }
}

class YjsAdapter implements SyncAdapter {
  readonly name = "yjs";
  readonly version = "13.6.31";
  readonly #seed: string;
  readonly #baseline: Uint8Array;
  readonly #clients = new Set<AdapterClient>();

  constructor(initial: JsonObject, seed: string) {
    this.#seed = seed;
    const baseline = new Y.Doc({ guid: "synclab:baseline", gc: false });
    baseline.clientID = clientNumber(seed, "baseline");
    const root = baseline.getMap<unknown>("root");
    baseline.transact(() => {
      for (const key of Object.keys(initial).sort()) root.set(key, toYValue(initial[key]!));
    }, "synclab:init");
    this.#baseline = Y.encodeStateAsUpdate(baseline);
    baseline.destroy();
  }

  async createClient(id: string): Promise<AdapterClient> {
    const client = new YjsClient(id, this.#seed, this.#baseline);
    this.#clients.add(client);
    return client;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#clients].map((client) => client.dispose()));
    this.#clients.clear();
  }
}

export const yjsAdapter: AdapterFactory = {
  name: "yjs",
  version: "13.6.31",
  async create(options: AdapterCreateOptions): Promise<SyncAdapter> {
    return new YjsAdapter(options.initial, options.seed);
  },
};

export default yjsAdapter;
