import { hashValue } from "./canonical.js";
import type { JsonValue, TraceEvent } from "./types.js";

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  readonly #onEvent: ((event: TraceEvent) => void) | undefined;
  #sequence = 0;

  constructor(onEvent?: (event: TraceEvent) => void) {
    this.#onEvent = onEvent;
  }

  emit(at: number, type: string, input: Omit<TraceEvent, "at" | "sequence" | "type"> = {}): TraceEvent {
    const event: TraceEvent = {
      sequence: this.#sequence,
      at,
      type,
      ...input,
    };
    this.#sequence += 1;
    this.events.push(event);
    this.#onEvent?.(event);
    return event;
  }

  checkpoint(at: number, name: string, details?: JsonValue): void {
    this.emit(at, "checkpoint", details === undefined ? { message: name } : { message: name, details });
  }

  fingerprint(extra?: JsonValue): string {
    return hashValue(extra === undefined ? this.events : { events: this.events, extra });
  }
}
