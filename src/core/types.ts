export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type PathSegment = number | string;
export type JsonPath = PathSegment[];

export type BuiltInAdapterName = "automerge" | "reference" | "yjs";

export interface ModuleAdapterSpec {
  module: string;
  options?: JsonObject;
}

export type AdapterSpec = BuiltInAdapterName | ModuleAdapterSpec;

export interface SetOperation {
  type: "set";
  path: JsonPath;
  value: JsonValue;
}

export interface DeleteOperation {
  type: "delete";
  path: JsonPath;
}

export interface IncrementOperation {
  type: "increment";
  path: JsonPath;
  by?: number;
}

export interface ListInsertOperation {
  type: "list-insert";
  path: JsonPath;
  index: number;
  values: JsonValue[];
}

export interface ListDeleteOperation {
  type: "list-delete";
  path: JsonPath;
  index: number;
  count?: number;
}

export interface TextInsertOperation {
  type: "text-insert";
  path: JsonPath;
  index: number;
  text: string;
}

export interface TextDeleteOperation {
  type: "text-delete";
  path: JsonPath;
  index: number;
  count: number;
}

export interface MergeOperation {
  type: "merge";
  path: JsonPath;
  value: JsonObject;
}

export interface CustomOperation {
  type: "custom";
  name: string;
  input?: JsonValue;
}

export type Operation =
  | SetOperation
  | DeleteOperation
  | IncrementOperation
  | ListInsertOperation
  | ListDeleteOperation
  | TextInsertOperation
  | TextDeleteOperation
  | MergeOperation
  | CustomOperation;

export type Durability = "durable" | "memory" | "rejected";

export interface MutationResult {
  update: Uint8Array;
  operationId: string;
  durability: Durability;
}

export interface AdapterContext {
  readonly clientId: string;
  readonly now: number;
  readonly random: () => number;
}

export interface AdapterClient {
  readonly id: string;
  mutate(operation: Operation, context: AdapterContext): Promise<MutationResult>;
  receive(update: Uint8Array, context: AdapterContext): Promise<void>;
  exportState(): Promise<Uint8Array>;
  snapshot(): Promise<JsonValue>;
  metadata(): Promise<JsonValue>;
  pending(): Promise<number>;
  restart(): Promise<void>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AdapterCreateOptions {
  readonly initial: JsonObject;
  readonly seed: string;
  readonly options: JsonObject;
}

export interface SyncAdapter {
  readonly name: string;
  readonly version: string;
  createClient(id: string): Promise<AdapterClient>;
  dispose(): Promise<void>;
}

export interface AdapterFactory {
  readonly name: string;
  readonly version: string;
  create(options: AdapterCreateOptions): Promise<SyncAdapter>;
}

export interface LatencyRange {
  min: number;
  max: number;
}

export interface NetworkConfig {
  latencyMs: number | LatencyRange;
  dropRate: number;
  duplicateRate: number;
  reorderRate: number;
  reorderWindowMs: number;
}

export interface ResourceLimits {
  maxEvents: number;
  maxQueuedMessages: number;
  maxPayloadBytes: number;
  maxVirtualTimeMs: number;
}

export interface ActionStep {
  action: {
    client: string;
    operation: Operation;
  };
}

export interface ParallelStep {
  parallel: Array<ActionStep["action"]>;
}

export interface PartitionStep {
  partition: {
    groups: string[][];
  };
}

export interface HealStep {
  heal: true | { clients?: string[] };
}

export interface NetworkStep {
  network: Partial<NetworkConfig> & {
    from?: string;
    to?: string;
  };
}

export interface TickStep {
  tick: number | { ms: number };
}

export interface SettleStep {
  settle: true | { maxEvents?: number };
}

export interface SyncStep {
  sync: true | { clients?: string[] };
}

export interface RestartStep {
  restart: string | { client: string; resync?: boolean };
}

export interface ResetStep {
  reset: string | { client: string; resync?: boolean };
}

export interface ClockStep {
  clock: {
    client: string;
    skewMs: number;
  };
}

export interface CheckpointStep {
  checkpoint: string;
}

export interface RepeatStep {
  repeat: {
    times: number;
    steps: ScenarioStep[];
  };
}

export interface ConvergedAssertion {
  type: "converged";
  clients?: string[];
  compareMetadata?: boolean;
}

export interface EqualsAssertion {
  type: "equals" | "not-equals";
  client: string;
  path?: JsonPath;
  value: JsonValue;
}

export interface AllEqualAssertion {
  type: "all-equal";
  path: JsonPath;
  value: JsonValue;
  clients?: string[];
}

export interface ContainsAssertion {
  type: "contains";
  client: string;
  path: JsonPath;
  value: JsonValue;
}

export interface LengthAssertion {
  type: "length";
  client: string;
  path: JsonPath;
  value: number;
}

export interface NoPendingAssertion {
  type: "no-pending";
}

export type Assertion =
  | ConvergedAssertion
  | EqualsAssertion
  | AllEqualAssertion
  | ContainsAssertion
  | LengthAssertion
  | NoPendingAssertion;

export interface AssertStep {
  assert: Assertion & { id?: string };
}

export type ScenarioStep =
  | ActionStep
  | ParallelStep
  | PartitionStep
  | HealStep
  | NetworkStep
  | TickStep
  | SettleStep
  | SyncStep
  | RestartStep
  | ResetStep
  | ClockStep
  | CheckpointStep
  | RepeatStep
  | AssertStep;

export interface Scenario {
  version: 1;
  name: string;
  description?: string;
  adapter: AdapterSpec;
  seed?: string | number;
  clients: string[];
  initial?: JsonObject;
  network?: Partial<NetworkConfig>;
  limits?: Partial<ResourceLimits>;
  steps: ScenarioStep[];
}

export type RunStatus = "pass" | "fail" | "invalid" | "inconclusive" | "harness-error";

export interface AssertionResult {
  id: string;
  type: Assertion["type"];
  status: "pass" | "fail";
  message: string;
  at: number;
  details?: JsonValue;
}

export interface ClientResult {
  id: string;
  state: JsonValue;
  stateHash: string;
  metadata: JsonValue;
  metadataHash: string;
}

export interface TraceEvent {
  sequence: number;
  at: number;
  type: string;
  client?: string;
  message?: string;
  details?: JsonValue;
}

export interface DecisionRecord {
  stream: string;
  sequence: number;
  label: string;
  value: number;
}

export interface RunEnvironment {
  synclab: string;
  node: string;
  platform: string;
  arch: string;
  adapter: string;
  adapterVersion: string;
  scenarioFormat: number;
  traceFormat: number;
  canonicalFormat: number;
  prng: string;
}

export interface RunReport {
  status: RunStatus;
  scenario: string;
  seed: string;
  virtualTimeMs: number;
  processedEvents: number;
  queuedMessages: number;
  assertions: AssertionResult[];
  clients: ClientResult[];
  failureSignature?: string;
  error?: string;
  traceFingerprint: string;
  environment: RunEnvironment;
}

export interface FailureArtifact {
  format: 1;
  scenario: Scenario;
  originalScenario?: Scenario;
  seed: string;
  report: RunReport;
  events: TraceEvent[];
  decisions: DecisionRecord[];
  minimizedScenario?: Scenario;
}

export interface RunOptions {
  seed?: string | number;
  adapter?: AdapterFactory;
  baseDirectory?: string;
  traceValues?: boolean;
  onEvent?: (event: TraceEvent) => void;
}
