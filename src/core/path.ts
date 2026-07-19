import { cloneJson } from "./canonical.js";
import { SyncLabError } from "./errors.js";
import type { JsonObject, JsonPath, JsonValue, Operation } from "./types.js";

function pathLabel(path: JsonPath): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getAtPath(root: JsonValue, path: JsonPath): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function parentAtPath(root: JsonObject, path: JsonPath): { parent: JsonObject | JsonValue[]; key: string | number } {
  if (path.length === 0) throw new SyncLabError("INVALID_PATH", "Operation paths cannot target the document root");
  let current: JsonValue = root;
  for (const segment of path.slice(0, -1)) {
    const next = getAtPath(current, [segment]);
    if (next === undefined) throw new SyncLabError("PATH_NOT_FOUND", `Path ${pathLabel(path)} does not exist`);
    current = next;
  }
  if (!Array.isArray(current) && !isRecord(current)) {
    throw new SyncLabError("PATH_TYPE", `Parent of ${pathLabel(path)} is not a container`);
  }
  return { parent: current, key: path[path.length - 1]! };
}

function listAtPath(root: JsonObject, path: JsonPath): JsonValue[] {
  const value = getAtPath(root, path);
  if (!Array.isArray(value)) throw new SyncLabError("PATH_TYPE", `${pathLabel(path)} is not a list`);
  return value;
}

export function applyPlainOperation(root: JsonObject, operation: Operation): void {
  switch (operation.type) {
    case "set": {
      const { parent, key } = parentAtPath(root, operation.path);
      if (Array.isArray(parent)) {
        if (typeof key !== "number" || key < 0 || key >= parent.length) {
          throw new SyncLabError("PATH_RANGE", `Invalid list index at ${pathLabel(operation.path)}`);
        }
        parent[key] = cloneJson(operation.value);
      } else {
        if (typeof key !== "string") throw new SyncLabError("PATH_TYPE", "Object keys must be strings");
        Object.defineProperty(parent, key, {
          value: cloneJson(operation.value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return;
    }
    case "delete": {
      const { parent, key } = parentAtPath(root, operation.path);
      if (Array.isArray(parent)) {
        if (typeof key !== "number") throw new SyncLabError("PATH_TYPE", "List indexes must be numbers");
        parent.splice(key, 1);
      } else {
        if (typeof key !== "string") throw new SyncLabError("PATH_TYPE", "Object keys must be strings");
        delete parent[key];
      }
      return;
    }
    case "increment": {
      const current = getAtPath(root, operation.path);
      if (typeof current !== "number") throw new SyncLabError("PATH_TYPE", `${pathLabel(operation.path)} is not a number`);
      applyPlainOperation(root, { type: "set", path: operation.path, value: current + (operation.by ?? 1) });
      return;
    }
    case "list-insert": {
      const list = listAtPath(root, operation.path);
      if (operation.index < 0 || operation.index > list.length) throw new SyncLabError("PATH_RANGE", "List insertion index is out of range");
      list.splice(operation.index, 0, ...operation.values.map((value) => cloneJson(value)));
      return;
    }
    case "list-delete": {
      const list = listAtPath(root, operation.path);
      if (operation.index < 0 || operation.index >= list.length) throw new SyncLabError("PATH_RANGE", "List deletion index is out of range");
      list.splice(operation.index, operation.count ?? 1);
      return;
    }
    case "text-insert": {
      const value = getAtPath(root, operation.path);
      if (typeof value !== "string") throw new SyncLabError("PATH_TYPE", `${pathLabel(operation.path)} is not text`);
      if (operation.index < 0 || operation.index > value.length) throw new SyncLabError("PATH_RANGE", "Text insertion index is out of range");
      applyPlainOperation(root, {
        type: "set",
        path: operation.path,
        value: `${value.slice(0, operation.index)}${operation.text}${value.slice(operation.index)}`,
      });
      return;
    }
    case "text-delete": {
      const value = getAtPath(root, operation.path);
      if (typeof value !== "string") throw new SyncLabError("PATH_TYPE", `${pathLabel(operation.path)} is not text`);
      if (operation.index < 0 || operation.index + operation.count > value.length) throw new SyncLabError("PATH_RANGE", "Text deletion range is out of bounds");
      applyPlainOperation(root, {
        type: "set",
        path: operation.path,
        value: `${value.slice(0, operation.index)}${value.slice(operation.index + operation.count)}`,
      });
      return;
    }
    case "merge": {
      const current = getAtPath(root, operation.path);
      if (!isRecord(current)) throw new SyncLabError("PATH_TYPE", `${pathLabel(operation.path)} is not an object`);
      for (const [key, value] of Object.entries(operation.value)) {
        Object.defineProperty(current, key, {
          value: cloneJson(value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return;
    }
    case "custom":
      throw new SyncLabError("UNSUPPORTED_OPERATION", "The built-in adapter does not support custom operations");
  }
}
