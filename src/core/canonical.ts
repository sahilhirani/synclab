import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

export const CANONICAL_FORMAT = 1;

function normalize(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers");
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON cannot encode cycles");
    seen.add(value);
    const result = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Canonical JSON cannot encode cycles");
    seen.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        Object.defineProperty(result, key, {
          value: normalize(entry, seen),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalize(value: unknown): JsonValue {
  return normalize(value, new Set());
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}
