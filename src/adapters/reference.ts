import { TextDecoder, TextEncoder } from "node:util";
import { canonicalize, cloneJson, hashValue } from "../core/canonical.js";
import { applyPlainOperation } from "../core/path.js";
import type {
  AdapterClient,
  AdapterContext,
  AdapterCreateOptions,
  AdapterFactory,
  JsonObject,
  JsonValue,
  MutationResult,
  Operation,
  SyncAdapter,
} from "../core/types.js";

interface OperationRecord {
  id: string;
  actor: string;
  sequence: number;
  time: number;
  operation: Operation;
}

interface ReferencePacket {
  format: 1;
  records: OperationRecord[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodePacket(records: OperationRecord[]): Uint8Array {
  return encoder.encode(JSON.stringify({ format: 1, records } satisfies ReferencePacket));
}

function decodePacket(update: Uint8Array): ReferencePacket {
  const value = JSON.parse(decoder.decode(update)) as Partial<ReferencePacket>;
  if (value.format !== 1 || !Array.isArray(value.records)) throw new TypeError("Invalid reference adapter update");
  return value as ReferencePacket;
}

function recordOrder(left: OperationRecord, right: OperationRecord): number {
  return left.sequence - right.sequence || left.actor.localeCompare(right.actor);
}

class ReferenceClient implements AdapterClient {
  readonly id: string;
  readonly #initial: JsonObject;
  readonly #records = new Map<string, OperationRecord>();
  #sequence = 0;
  #generation = 0;

  constructor(id: string, initial: JsonObject) {
    this.id = id;
    this.#initial = cloneJson(initial);
  }

  async mutate(operation: Operation, context: AdapterContext): Promise<MutationResult> {
    const sequence = this.#sequence;
    this.#sequence += 1;
    const actor = `${this.id}#${this.#generation}`;
    const record: OperationRecord = {
      id: `${actor}:${sequence}`,
      actor,
      sequence,
      time: context.now,
      operation: structuredClone(operation),
    };
    this.#records.set(record.id, record);
    try {
      await this.snapshot();
    } catch (error) {
      this.#records.delete(record.id);
      this.#sequence -= 1;
      throw error;
    }
    return {
      update: encodePacket([record]),
      operationId: record.id,
      durability: "durable",
    };
  }

  async receive(update: Uint8Array): Promise<void> {
    const packet = decodePacket(update);
    for (const record of packet.records) {
      if (!this.#records.has(record.id)) this.#records.set(record.id, record);
    }
  }

  async exportState(): Promise<Uint8Array> {
    return encodePacket([...this.#records.values()].sort(recordOrder));
  }

  async snapshot(): Promise<JsonValue> {
    const result = cloneJson(this.#initial);
    for (const record of [...this.#records.values()].sort(recordOrder)) {
      applyPlainOperation(result, record.operation);
    }
    return canonicalize(result);
  }

  async metadata(): Promise<JsonValue> {
    const ids = [...this.#records.keys()].sort();
    return { operationCount: ids.length, operationSetHash: hashValue(ids) };
  }

  async pending(): Promise<number> {
    return 0;
  }

  async restart(): Promise<void> {
    // The operation log is the reference adapter's durable storage.
  }

  async reset(): Promise<void> {
    this.#records.clear();
    this.#sequence = 0;
    this.#generation += 1;
  }

  async dispose(): Promise<void> {
    this.#records.clear();
  }
}

class ReferenceAdapter implements SyncAdapter {
  readonly name = "reference";
  readonly version = "1";
  readonly #initial: JsonObject;
  readonly #clients = new Set<AdapterClient>();

  constructor(initial: JsonObject) {
    this.#initial = cloneJson(initial);
  }

  async createClient(id: string): Promise<AdapterClient> {
    const client = new ReferenceClient(id, this.#initial);
    this.#clients.add(client);
    return client;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#clients].map((client) => client.dispose()));
    this.#clients.clear();
  }
}

export const referenceAdapter: AdapterFactory = {
  name: "reference",
  version: "1",
  async create(options: AdapterCreateOptions): Promise<SyncAdapter> {
    return new ReferenceAdapter(options.initial);
  },
};

export default referenceAdapter;
