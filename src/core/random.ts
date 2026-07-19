import type { DecisionRecord } from "./types.js";

const UINT32_RANGE = 0x1_0000_0000;

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function nonZeroSeed(value: number): number {
  const seed = value >>> 0;
  return seed === 0 ? 0x6d2b79f5 : seed;
}

export class RandomStream {
  readonly name: string;
  #state: number;
  #sequence = 0;
  readonly #record: (decision: DecisionRecord) => void;

  constructor(seed: string, name: string, record: (decision: DecisionRecord) => void) {
    this.name = name;
    this.#state = nonZeroSeed(hashString(`${seed}\u0000${name}`));
    this.#record = record;
  }

  next(label = "draw"): number {
    let state = this.#state;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.#state = state >>> 0;
    const value = this.#state / UINT32_RANGE;
    this.#record({
      stream: this.name,
      sequence: this.#sequence,
      label,
      value,
    });
    this.#sequence += 1;
    return value;
  }

  chance(probability: number, label: string): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return this.next(label) < probability;
  }

  integer(min: number, max: number, label: string): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`Invalid integer range ${min}..${max}`);
    }
    return min + Math.floor(this.next(label) * (max - min + 1));
  }
}

export class DeterministicRandom {
  static readonly algorithm = "xorshift32-v1";
  readonly seed: string;
  readonly decisions: DecisionRecord[] = [];
  readonly #streams = new Map<string, RandomStream>();

  constructor(seed: string | number) {
    this.seed = String(seed);
  }

  stream(name: string): RandomStream {
    const existing = this.#streams.get(name);
    if (existing) return existing;
    const stream = new RandomStream(this.seed, name, (decision) => this.decisions.push(decision));
    this.#streams.set(name, stream);
    return stream;
  }
}
