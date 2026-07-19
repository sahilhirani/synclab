import { hashValue } from "./canonical.js";
import { ResourceLimitError, SyncLabError } from "./errors.js";
import type { NetworkConfig, ResourceLimits } from "./types.js";
import type { DeterministicRandom } from "./random.js";
import type { TraceRecorder } from "./trace.js";

interface Envelope {
  id: string;
  from: string;
  to: string;
  kind: "delta" | "sync";
  payload: Uint8Array;
  sentAt: number;
  deliverAt: number;
  copy: number;
  order: number;
}

type Deliver = (envelope: Readonly<Envelope>) => Promise<void>;

const DEFAULT_NETWORK: NetworkConfig = {
  latencyMs: 0,
  dropRate: 0,
  duplicateRate: 0,
  reorderRate: 0,
  reorderWindowMs: 0,
};

function linkKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function validateProbability(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new SyncLabError("INVALID_NETWORK", `${field} must be between 0 and 1`);
  }
}

function normalizeConfig(config: Partial<NetworkConfig>, base = DEFAULT_NETWORK): NetworkConfig {
  const merged: NetworkConfig = { ...base, ...config };
  validateProbability(merged.dropRate, "dropRate");
  validateProbability(merged.duplicateRate, "duplicateRate");
  validateProbability(merged.reorderRate, "reorderRate");
  if (!Number.isFinite(merged.reorderWindowMs) || merged.reorderWindowMs < 0) {
    throw new SyncLabError("INVALID_NETWORK", "reorderWindowMs must be non-negative");
  }
  const latency = typeof merged.latencyMs === "number" ? { min: merged.latencyMs, max: merged.latencyMs } : merged.latencyMs;
  if (!Number.isFinite(latency.min) || !Number.isFinite(latency.max) || latency.min < 0 || latency.max < latency.min) {
    throw new SyncLabError("INVALID_NETWORK", "latencyMs must be a non-negative number or valid min/max range");
  }
  return merged;
}

export class SimulatedNetwork {
  #now = 0;
  #processed = 0;
  #messageSequence = 0;
  #queueOrder = 0;
  #global: NetworkConfig;
  readonly #links = new Map<string, NetworkConfig>();
  readonly #blocked = new Set<string>();
  readonly #queue: Envelope[] = [];
  readonly #random: DeterministicRandom;
  readonly #trace: TraceRecorder;
  readonly #limits: ResourceLimits;
  readonly #deliver: Deliver;

  constructor(input: {
    config?: Partial<NetworkConfig>;
    random: DeterministicRandom;
    trace: TraceRecorder;
    limits: ResourceLimits;
    deliver: Deliver;
  }) {
    this.#global = normalizeConfig(input.config ?? {});
    this.#random = input.random;
    this.#trace = input.trace;
    this.#limits = input.limits;
    this.#deliver = input.deliver;
  }

  get now(): number {
    return this.#now;
  }

  get processedEvents(): number {
    return this.#processed;
  }

  get queuedMessages(): number {
    return this.#queue.length;
  }

  configure(config: Partial<NetworkConfig>, from?: string, to?: string): void {
    if ((from === undefined) !== (to === undefined)) {
      throw new SyncLabError("INVALID_NETWORK", "A link override requires both from and to");
    }
    if (from !== undefined && to !== undefined) {
      const key = linkKey(from, to);
      const base = this.#links.get(key) ?? this.#global;
      this.#links.set(key, normalizeConfig(config, base));
      this.#trace.emit(this.#now, "network.configured", { details: { from, to, ...config } as never });
      return;
    }
    this.#global = normalizeConfig(config, this.#global);
    this.#trace.emit(this.#now, "network.configured", { details: config as never });
  }

  partition(groups: string[][]): void {
    this.#blocked.clear();
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        for (const from of groups[left]!) {
          for (const to of groups[right]!) {
            this.#blocked.add(linkKey(from, to));
            this.#blocked.add(linkKey(to, from));
          }
        }
      }
    }
    this.#trace.emit(this.#now, "network.partitioned", { details: { groups } });
  }

  heal(clients?: string[]): void {
    if (clients === undefined) this.#blocked.clear();
    else {
      const selected = new Set(clients);
      for (const key of this.#blocked) {
        const [from, to] = key.split("\u0000");
        if (selected.has(from!) || selected.has(to!)) this.#blocked.delete(key);
      }
    }
    this.#trace.emit(this.#now, "network.healed", clients === undefined ? {} : { details: { clients } });
  }

  isBlocked(from: string, to: string): boolean {
    return this.#blocked.has(linkKey(from, to));
  }

  send(from: string, to: string, payload: Uint8Array, kind: "delta" | "sync" = "delta"): void {
    if (payload.byteLength > this.#limits.maxPayloadBytes) {
      throw new ResourceLimitError(`Payload of ${payload.byteLength} bytes exceeds maxPayloadBytes=${this.#limits.maxPayloadBytes}`);
    }
    const baseId = `${from}:${this.#messageSequence}:${to}`;
    this.#messageSequence += 1;
    const details = {
      id: baseId,
      from,
      to,
      kind,
      bytes: payload.byteLength,
      payloadHash: hashValue(payload),
    };
    if (this.isBlocked(from, to)) {
      this.#trace.emit(this.#now, "message.blocked", { details });
      return;
    }
    const config = this.#links.get(linkKey(from, to)) ?? this.#global;
    const random = this.#random.stream(`network:${from}->${to}`);
    if (random.chance(config.dropRate, `${baseId}:drop`)) {
      this.#trace.emit(this.#now, "message.dropped", { details: { ...details, reason: "fault" } });
      return;
    }
    const copies = random.chance(config.duplicateRate, `${baseId}:duplicate`) ? 2 : 1;
    if (this.#queue.length + copies > this.#limits.maxQueuedMessages) {
      this.#trace.emit(this.#now, "message.rejected", {
        details: { ...details, reason: "queue-limit", copies, queued: this.#queue.length },
      });
      throw new ResourceLimitError(`Queued messages would exceed maxQueuedMessages=${this.#limits.maxQueuedMessages}`);
    }
    for (let copy = 0; copy < copies; copy += 1) {
      const latency = typeof config.latencyMs === "number"
        ? config.latencyMs
        : config.latencyMs.min + random.next(`${baseId}:${copy}:latency`) * (config.latencyMs.max - config.latencyMs.min);
      const reorder = random.chance(config.reorderRate, `${baseId}:${copy}:reorder`)
        ? random.next(`${baseId}:${copy}:reorder-window`) * config.reorderWindowMs
        : 0;
      const envelope: Envelope = {
        id: `${baseId}:${copy}`,
        from,
        to,
        kind,
        payload: new Uint8Array(payload),
        sentAt: this.#now,
        deliverAt: this.#now + latency + reorder,
        copy,
        order: this.#queueOrder,
      };
      this.#queueOrder += 1;
      this.#queue.push(envelope);
      this.#trace.emit(this.#now, copy === 0 ? "message.queued" : "message.duplicated", {
        details: { ...details, id: envelope.id, deliverAt: envelope.deliverAt, copy },
      });
    }
  }

  broadcast(from: string, recipients: Iterable<string>, payload: Uint8Array, kind: "delta" | "sync" = "delta"): void {
    for (const to of [...recipients].filter((id) => id !== from).sort()) this.send(from, to, payload, kind);
  }

  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new SyncLabError("INVALID_TIME", "tick must be a non-negative number");
    const target = this.#now + ms;
    await this.#processUntil(target, Number.POSITIVE_INFINITY);
    this.#now = target;
    this.#checkVirtualTime();
    this.#trace.emit(this.#now, "time.advanced", { details: { byMs: ms } });
  }

  async settle(maxEvents = this.#limits.maxEvents): Promise<void> {
    const started = this.#processed;
    while (this.#queue.length > 0) {
      if (this.#processed - started >= maxEvents) {
        throw new ResourceLimitError(`Settlement exceeded maxEvents=${maxEvents}`);
      }
      this.#sortQueue();
      const next = this.#queue[0]!;
      await this.#processUntil(next.deliverAt, 1);
      if (this.#now < next.deliverAt) this.#now = next.deliverAt;
      this.#checkVirtualTime();
    }
    this.#trace.emit(this.#now, "network.settled", { details: { events: this.#processed - started } });
  }

  async #processUntil(target: number, max: number): Promise<void> {
    let count = 0;
    this.#sortQueue();
    while (this.#queue.length > 0 && this.#queue[0]!.deliverAt <= target && count < max) {
      const envelope = this.#queue.shift()!;
      this.#now = Math.max(this.#now, envelope.deliverAt);
      this.#checkVirtualTime();
      this.#processed += 1;
      count += 1;
      if (this.#processed > this.#limits.maxEvents) {
        throw new ResourceLimitError(`Processed events exceed maxEvents=${this.#limits.maxEvents}`);
      }
      if (this.isBlocked(envelope.from, envelope.to)) {
        this.#trace.emit(this.#now, "message.dropped", {
          details: { id: envelope.id, from: envelope.from, to: envelope.to, reason: "partition-at-delivery" },
        });
      } else {
        await this.#deliver(envelope);
        this.#trace.emit(this.#now, "message.delivered", {
          details: { id: envelope.id, from: envelope.from, to: envelope.to, kind: envelope.kind, copy: envelope.copy },
        });
      }
      this.#sortQueue();
    }
  }

  #sortQueue(): void {
    this.#queue.sort((left, right) => left.deliverAt - right.deliverAt || left.order - right.order || left.id.localeCompare(right.id));
  }

  #checkVirtualTime(): void {
    if (this.#now > this.#limits.maxVirtualTimeMs) {
      throw new ResourceLimitError(`Virtual time exceeds maxVirtualTimeMs=${this.#limits.maxVirtualTimeMs}`);
    }
  }
}
