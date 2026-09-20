export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Outcome =
  | "verified"
  | "refuted"
  | "unknown"
  | "abstained"
  | "approval_required"
  | "denied"
  | "budget_exhausted"
  | "setup_required"
  | "shadow_complete";

export type RiskClass =
  | "r0_read_only"
  | "r1_reversible"
  | "r2_private"
  | "r3_consequential"
  | "r4_forbidden";

export type CandidateAction = Readonly<{
  tool: string;
  arguments: Readonly<Record<string, JsonValue>>;
}>;

export type Candidate = Readonly<{
  id: string;
  semanticKey: string;
  description: string;
  risk: RiskClass;
  action: CandidateAction | null;
  actionDigest: string | null;
  authorization?: "approved_workflow";
  expectedEffect: string;
  observationDigest: string;
}>;

export type CandidateDecision = Readonly<{
  selectedId: string;
  confidence: number;
  probabilities: Readonly<Record<string, number>>;
  selectedFit: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}>;

export type BrowserRef = Readonly<{
  ref: string;
  role: string;
  name: string;
  value?: string;
  actions: readonly string[];
  disabled: boolean;
  frame: string;
  visibility: string;
}>;

export type BrowserObservation = Readonly<{
  targetId: string;
  tabId: string;
  snapshotId: string;
  url: string;
  title?: string;
  outline?: string;
  refs: readonly BrowserRef[];
  complete: boolean;
  continuation?: string;
  digest: string;
}>;

export type ValueSlot = Readonly<{
  id: string;
  description: string;
  value: string;
  targetHints: readonly string[];
  secret: boolean;
  classification?: "public" | "private";
}>;

export type ExactSuccessCondition =
  | Readonly<{ kind: "exact_url"; origin: string; pathname: string }>
  | Readonly<{
      kind: "exact_control_visible";
      page: Readonly<{ origin: string; pathname: string }>;
      control: Readonly<{ role: string; name: string }>;
      requiredAction: "click" | "type" | "scroll";
    }>
  | Readonly<{
      kind: "exact_field_equals";
      page: Readonly<{ origin: string; pathname: string }>;
      field: Readonly<{ role: string; name: string }>;
      inputId: string;
    }>;

export type SuccessCondition =
  | Readonly<{ kind: "url_includes"; value: string }>
  | Readonly<{ kind: "text_present"; value: string }>
  | Readonly<{ kind: "field_equals"; fieldName: string; valueSlotId: string }>
  | ExactSuccessCondition;

export type BrowserTarget =
  | Readonly<{
      kind: "bound";
      targetId: string;
      tabId: string;
    }>
  | Readonly<{
      kind: "window";
      pid: number;
      windowId: number;
      tabTitle?: string;
    }>
  | Readonly<{
      kind: "isolated";
      startUrl: string;
      navigationEffect: "read_only_landing";
    }>;

export type RunMode = "shadow" | "live";

export type RunRequest = Readonly<{
  runKey: string;
  policyFingerprint: string;
  goal: string;
  target: BrowserTarget;
  values: readonly ValueSlot[];
  success: SuccessCondition;
  allowedOrigins: readonly string[];
  mode: RunMode;
  maxSteps: number;
  maxWallTimeMs: number;
  workflowSteps: readonly Readonly<{
    semanticKey: string;
    ensures: ExactSuccessCondition;
  }>[];
}>;

export type StepTrace = Readonly<{
  step: number;
  candidateCount: number;
  selectedSemanticKey?: string;
  risk?: RiskClass;
  decisionMs: number;
  actionMs: number;
  verificationMs: number;
  outcome?: Outcome;
}>;

export type RunResult = Readonly<{
  runId: string;
  runKeyHash: string;
  outcome: Outcome;
  reason: string;
  steps: readonly StepTrace[];
  startedAt: string;
  finishedAt: string;
  model?: string | undefined;
  frontierFallbackRecommended: boolean;
  reconciliationRequired: boolean;
  safeToRetry: boolean;
  cleanupSucceeded: boolean | null;
}>;

export type DriverToolDescriptor = Readonly<{
  name: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}>;

export interface DriverClient {
  connect(): Promise<void>;
  listTools(): Promise<readonly DriverToolDescriptor[]>;
  call(
    tool: string,
    arguments_: Record<string, JsonValue>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface DecisionPolicy {
  choose(
    input: Readonly<{
      goal: string;
      observation: BrowserObservation;
      candidates: readonly Candidate[];
      previousStep?: StepTrace;
      signal?: AbortSignal;
    }>,
  ): Promise<CandidateDecision>;
}

export type CandidateBuilder = (
  input: Readonly<{
    observation: BrowserObservation;
    values: readonly ValueSlot[];
    maximum: number;
    labelMaxLength: number;
    privateState: boolean;
    completedSemanticKeys: ReadonlySet<string>;
  }>,
) => readonly Candidate[];

export interface TraceSink {
  append(
    runId: string,
    event: Readonly<Record<string, JsonValue>>,
  ): Promise<void>;
}
