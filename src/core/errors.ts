export class SyncLabError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncLabError";
    this.code = code;
  }
}

export class ScenarioValidationError extends SyncLabError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("INVALID_SCENARIO", `Invalid scenario:\n- ${issues.join("\n- ")}`);
    this.name = "ScenarioValidationError";
    this.issues = issues;
  }
}

export class InvariantError extends SyncLabError {
  readonly invariantId: string;

  constructor(invariantId: string, message: string) {
    super("INVARIANT_FAILED", message);
    this.name = "InvariantError";
    this.invariantId = invariantId;
  }
}

export class ResourceLimitError extends SyncLabError {
  constructor(message: string) {
    super("RESOURCE_LIMIT", message);
    this.name = "ResourceLimitError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
