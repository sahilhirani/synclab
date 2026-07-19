import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { automergeAdapter } from "./automerge.js";
import { referenceAdapter } from "./reference.js";
import { yjsAdapter } from "./yjs.js";
import { SyncLabError } from "../core/errors.js";
import type { AdapterFactory, AdapterSpec, BuiltInAdapterName } from "../core/types.js";

export const builtInAdapters: Readonly<Record<BuiltInAdapterName, AdapterFactory>> = {
  automerge: automergeAdapter,
  reference: referenceAdapter,
  yjs: yjsAdapter,
};

function isAdapterFactory(value: unknown): value is AdapterFactory {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AdapterFactory>;
  return typeof candidate.name === "string" && typeof candidate.version === "string" && typeof candidate.create === "function";
}

export async function resolveAdapter(spec: AdapterSpec, baseDirectory = process.cwd()): Promise<AdapterFactory> {
  if (typeof spec === "string") return builtInAdapters[spec];
  const absolute = isAbsolute(spec.module) ? spec.module : resolve(baseDirectory, spec.module);
  const loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  const candidate = loaded.default ?? loaded.adapter;
  if (!isAdapterFactory(candidate)) {
    throw new SyncLabError("INVALID_ADAPTER", `Module ${absolute} must export an AdapterFactory as default or \"adapter\"`);
  }
  return candidate;
}

export { automergeAdapter, referenceAdapter, yjsAdapter };
