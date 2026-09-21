import { createHash, createHmac, randomBytes } from "node:crypto";

import type { RiskClass } from "../types.js";
import type { DriverImageContent } from "../types.js";
import { AsyncMutex, randomOpaqueId } from "../util.js";
import type {
  NativeAction,
  NativeActionKind,
  NativeAppSummary,
  NativeApprovalDecision,
  NativeApprovalGate,
  NativeCandidate,
  NativeEndResult,
  NativeExecutionResult,
  NativeLaunchResult,
  NativeObservation,
  NativeVerification,
  NativeVisualDetail,
  NativeVisualOverview,
  NativeWindowSummary,
  NativeWindowTarget,
} from "./types.js";

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const MAX_PUBLIC_CANDIDATES = 100;
const MAX_ACTION_BINDINGS = 128;
const MAX_END_TOMBSTONES = 16;
const MAX_STEP_TOMBSTONES = 256;
const RECOGNIZABLE_CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:sk|pk|apikey|token|secret)[-_][A-Za-z0-9_-]{12,}\b/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}\b/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/iu,
]);
const SAFE_SCROLLS = Object.freeze([
  Object.freeze({ direction: "up" as const, description: "Scroll up 3 lines" }),
  Object.freeze({
    direction: "down" as const,
    description: "Scroll down 3 lines",
  }),
]);
const SAFE_KEYS = Object.freeze([
  Object.freeze({ key: "escape", description: "Press Escape" }),
  Object.freeze({ key: "tab", description: "Press Tab" }),
  Object.freeze({ key: "up", description: "Press Up Arrow" }),
  Object.freeze({ key: "down", description: "Press Down Arrow" }),
  Object.freeze({ key: "left", description: "Press Left Arrow" }),
  Object.freeze({ key: "right", description: "Press Right Arrow" }),
  Object.freeze({ key: "home", description: "Press Home" }),
  Object.freeze({ key: "end", description: "Press End" }),
  Object.freeze({ key: "pageup", description: "Press Page Up" }),
  Object.freeze({ key: "pagedown", description: "Press Page Down" }),
]);
const APPROVAL_KEYS = Object.freeze([
  Object.freeze({ key: "return", description: "Press Return" }),
  Object.freeze({ key: "space", description: "Press Space" }),
  Object.freeze({ key: "delete", description: "Press Delete" }),
]);

export interface NativeCoreFacade {
  listApps(): Promise<readonly NativeAppSummary[]>;
  launchApp?(
    input: Readonly<{
      appRef: string;
      operationKey: string;
    }>,
  ): Promise<NativeLaunchResult>;
  listWindows(
    input: Readonly<{ appRef: string }>,
  ): Promise<readonly NativeWindowSummary[]>;
  observe(target: NativeWindowTarget): Promise<NativeObservation>;
  observeVisual?(target: NativeWindowTarget): Promise<NativeVisualOverview>;
  refineVisual?(
    input: Readonly<{
      overviewId: string;
      regionId: string;
    }>,
  ): Promise<NativeVisualDetail>;
  execute(
    input: Readonly<{
      operationKey: string;
      observationId: string;
      candidateId: string;
      action: NativeAction;
      verification: NativeVerification;
      authorizeConsequentialAction?: NativeApprovalGate;
    }>,
  ): Promise<NativeExecutionResult>;
  quarantine(): Promise<void>;
  end(): Promise<NativeEndResult>;
}

export type NativePublicApp = Readonly<{
  appRef: string;
  name: string;
  running: boolean;
  active: boolean;
  launchable: boolean;
  untrustedText: true;
}>;

export type NativePublicWindow = Readonly<{
  appRef: string;
  windowRef: string;
  title: string;
  onScreen: boolean;
  onCurrentSpace: boolean | null;
  minimized: boolean | null;
  untrustedText: true;
}>;

export type NativeActionAvailability =
  | "allowed"
  | "approval_required"
  | "denied"
  | "not_exposed";

export type NativePublicAction = Readonly<{
  actionRef?: string;
  kind: NativeActionKind;
  description: string;
  risk: RiskClass;
  availability: NativeActionAvailability;
}>;

export type NativePublicCandidate = Readonly<{
  candidateRef: string;
  targetKind: "window" | "element" | "visual_cell";
  role: string;
  label?: string;
  valuePresent: boolean;
  enabled?: boolean | null;
  selected?: boolean | null;
  actions: readonly NativePublicAction[];
  untrustedText: true;
}>;

export type NativePublicObservation = Readonly<{
  observationRef: string;
  windowRef: string;
  complete: boolean;
  actionable: boolean;
  candidateCount: number;
  candidates: readonly NativePublicCandidate[];
  untrustedUiData: true;
}>;

export type NativeStartResult = Readonly<{
  runRef: string;
  apps: readonly NativePublicApp[];
}>;

export type NativePublicLaunchResult = Readonly<{
  outcome: NativeLaunchResult["outcome"];
  reasonCode: NativeLaunchResult["reasonCode"];
  app?: NativePublicApp;
  mutationAttempted: boolean;
  reconciliationRequired: boolean;
  safeToRetry: boolean;
  replayed: boolean;
}>;

export type NativePublicVisualOverview = Readonly<{
  visualObservationRef: string;
  windowRef: string;
  width: number;
  height: number;
  image: DriverImageContent;
  regions: readonly Readonly<{ regionRef: string; label: string }>[];
}>;

export type NativePublicVisualDetail = Readonly<{
  observation: NativePublicObservation;
  width: number;
  height: number;
  image: DriverImageContent;
}>;

export type NativeVisualDisclosureContext = Readonly<{
  appLabel: string;
  windowLabel: string;
  untrustedUiData: true;
}>;

export type NativeApprovalContext = Readonly<{
  runRef: string;
  observationRef: string;
  actionRef: string;
  operationFingerprint: string;
  actionKind: NativeActionKind;
  actionDescription: string;
  risk: "r2_private" | "r3_consequential";
  appLabel: string;
  windowLabel: string;
  controlRole: string;
  controlLabel?: string;
  text?: string;
  untrustedUiData: true;
}>;

export type NativeApprovalHandler = (
  context: NativeApprovalContext,
) => Promise<NativeApprovalDecision> | NativeApprovalDecision;

type AppBinding = Readonly<{
  coreAppRef: string;
  name: string;
  running: boolean;
  active: boolean;
  launchable: boolean;
}>;
type WindowBinding = Readonly<{
  publicAppRef: string;
  coreWindowRef: string;
  title: string;
}>;
type BoundAction =
  | Readonly<{ source: "fixed"; value: NativeAction }>
  | Readonly<{ source: "text"; kind: "set_value" | "type_text" }>;
type ActionBinding = Readonly<{
  observationRef: string;
  coreObservationId: string;
  coreCandidateId: string;
  action: BoundAction;
  actionDescription: string;
  risk: RiskClass;
  availability: "allowed" | "approval_required";
  appLabel: string;
  windowLabel: string;
  controlRole: string;
  controlLabel?: string;
}>;
type VisualOverviewBinding = Readonly<{
  windowRef: string;
  coreOverviewId: string;
  regions: ReadonlyMap<string, string>;
}>;

type ActiveRun = {
  readonly runRef: string;
  readonly core: NativeCoreFacade;
  readonly apps: Map<string, AppBinding>;
  readonly windows: Map<string, WindowBinding>;
  readonly observations: Set<string>;
  readonly actions: Map<string, ActionBinding>;
  readonly visualOverviews: Map<string, VisualOverviewBinding>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type StepTombstone = Readonly<{
  requestDigest: string;
  result: NativeExecutionResult;
}>;

type EndTombstone = Readonly<{
  result: NativeEndResult;
  retryCore?: NativeCoreFacade;
}>;

function unavailableAction(
  kind: NativeActionKind,
  description: string,
  risk: RiskClass,
  availability: Exclude<NativeActionAvailability, "allowed">,
): NativePublicAction {
  return Object.freeze({ kind, description, risk, availability });
}

function unavailableForRisk(
  risk: RiskClass,
): Exclude<NativeActionAvailability, "allowed"> {
  if (risk === "r2_private" || risk === "r3_consequential")
    return "approval_required";
  if (risk === "r4_forbidden") return "denied";
  return "not_exposed";
}

function containsRecognizableCredential(value: string): boolean {
  return RECOGNIZABLE_CREDENTIAL_PATTERNS.some((pattern) =>
    pattern.test(value),
  );
}

export class NativeManagerError extends Error {
  constructor(
    message: string,
    readonly reconciliationRequired: boolean,
  ) {
    super(message);
    this.name = "NativeManagerError";
  }
}

/**
 * The model-facing native capability layer. Core object identifiers and all
 * executable action arguments remain in this manager; callers receive only
 * short-lived random handles for a deliberately small set of reversible
 * actions.
 */
export class NativeRunManager {
  private readonly mutex = new AsyncMutex();
  private readonly approvalIdentityKey = randomBytes(32);
  private readonly idleTtlMs: number;
  private readonly endTombstones = new Map<string, EndTombstone>();
  private readonly stepTombstones = new Map<string, StepTombstone>();
  private active: ActiveRun | undefined;

  constructor(
    private readonly dependencies: Readonly<{
      createCore: () => NativeCoreFacade;
      idleTtlMs?: number;
    }>,
  ) {
    this.idleTtlMs = dependencies.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (
      !Number.isSafeInteger(this.idleTtlMs) ||
      this.idleTtlMs < 1 ||
      this.idleTtlMs > 60 * 60_000
    ) {
      throw new Error("native run idle TTL is invalid");
    }
  }

  async start(): Promise<NativeStartResult> {
    return this.mutex.runExclusive(async () => {
      if (this.active)
        throw new Error("a native computer-use run is already active");
      const core = this.dependencies.createCore();
      let coreApps: readonly NativeAppSummary[];
      try {
        coreApps = await core.listApps();
      } catch {
        const cleanup = await this.endCore(core);
        if (!cleanup.cleanupSucceeded || cleanup.reconciliationRequired) {
          throw new NativeManagerError(
            "native computer-use startup cleanup requires reconciliation",
            true,
          );
        }
        throw new NativeManagerError(
          "native computer-use run could not be started",
          false,
        );
      }

      const runRef = randomOpaqueId("nrun");
      const active: ActiveRun = {
        runRef,
        core,
        apps: new Map(),
        windows: new Map(),
        observations: new Set(),
        actions: new Map(),
        visualOverviews: new Map(),
      };
      const apps = Object.freeze(
        coreApps.map((app): NativePublicApp => {
          const appRef = randomOpaqueId("napp");
          active.apps.set(
            appRef,
            Object.freeze({
              coreAppRef: app.appRef,
              name: app.name,
              running: app.running,
              active: app.active,
              launchable: app.launchable,
            }),
          );
          return Object.freeze({
            appRef,
            name: app.name,
            running: app.running,
            active: app.active,
            launchable: app.launchable,
            untrustedText: true,
          });
        }),
      );
      this.active = active;
      this.touch(active);
      return Object.freeze({ runRef, apps });
    });
  }

  async launchApp(
    input: Readonly<{
      runRef: string;
      appRef: string;
      operationKey: string;
    }>,
  ): Promise<NativePublicLaunchResult> {
    return this.mutex.runExclusive(async () => {
      const active = this.requireRun(input.runRef);
      const binding = active.apps.get(input.appRef);
      if (!binding) throw new Error("native app reference is stale or invalid");
      if (!active.core.launchApp)
        throw new Error("native app launch is unavailable");
      let result: NativeLaunchResult;
      try {
        result = await active.core.launchApp({
          appRef: binding.coreAppRef,
          operationKey: input.operationKey,
        });
      } catch {
        result = Object.freeze({
          outcome: "unknown",
          reasonCode: "reconciliation_required",
          mutationAttempted: true,
          reconciliationRequired: true,
          safeToRetry: false,
          replayed: false,
        });
        await active.core.quarantine().catch(() => undefined);
      }
      let app: NativePublicApp | undefined;
      if (result.app) {
        active.apps.set(
          input.appRef,
          Object.freeze({
            coreAppRef: result.app.appRef,
            name: result.app.name,
            running: result.app.running,
            active: result.app.active,
            launchable: result.app.launchable,
          }),
        );
        app = Object.freeze({
          appRef: input.appRef,
          name: result.app.name,
          running: result.app.running,
          active: result.app.active,
          launchable: result.app.launchable,
          untrustedText: true,
        });
      }
      this.clearWindowCapabilities(active);
      this.touch(active);
      return Object.freeze({
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        ...(app ? { app } : {}),
        mutationAttempted: result.mutationAttempted,
        reconciliationRequired: result.reconciliationRequired,
        safeToRetry: result.safeToRetry,
        replayed: result.replayed,
      });
    });
  }

  async listWindows(
    input: Readonly<{ runRef: string; appRef: string }>,
  ): Promise<readonly NativePublicWindow[]> {
    return this.mutex.runExclusive(async () => {
      const active = this.requireRun(input.runRef);
      const app = active.apps.get(input.appRef);
      if (!app) throw new Error("native app reference is stale or invalid");
      if (!app.running)
        throw new Error("native app is stopped and must be launched first");
      let coreWindows: readonly NativeWindowSummary[];
      try {
        coreWindows = await active.core.listWindows({
          appRef: app.coreAppRef,
        });
      } catch {
        throw new Error("native window inventory could not be read");
      }
      this.clearWindowCapabilities(active);
      const windows = Object.freeze(
        coreWindows.map((window): NativePublicWindow => {
          const windowRef = randomOpaqueId("nwin");
          active.windows.set(
            windowRef,
            Object.freeze({
              publicAppRef: input.appRef,
              coreWindowRef: window.windowRef,
              title: window.title,
            }),
          );
          return Object.freeze({
            appRef: input.appRef,
            windowRef,
            title: window.title,
            onScreen: window.onScreen,
            onCurrentSpace: window.onCurrentSpace,
            minimized: window.minimized,
            untrustedText: true,
          });
        }),
      );
      this.touch(active);
      return windows;
    });
  }

  async observe(
    input: Readonly<{ runRef: string; windowRef: string }>,
  ): Promise<NativePublicObservation> {
    return this.mutex.runExclusive(async () => {
      const active = this.requireRun(input.runRef);
      const window = active.windows.get(input.windowRef);
      if (!window)
        throw new Error("native window reference is stale or invalid");
      let observation: NativeObservation;
      try {
        observation = await active.core.observe({
          windowRef: window.coreWindowRef,
        });
      } catch {
        throw new Error("native window could not be observed");
      }
      this.clearObservationCapabilities(active);
      const published = this.publishObservation(
        active,
        input.windowRef,
        observation,
      );
      this.touch(active);
      return published;
    });
  }

  async observeVisual(
    input: Readonly<{ runRef: string; windowRef: string }>,
  ): Promise<NativePublicVisualOverview> {
    return this.mutex.runExclusive(async () => {
      const active = this.requireRun(input.runRef);
      const window = active.windows.get(input.windowRef);
      if (!window)
        throw new Error("native window reference is stale or invalid");
      let overview: NativeVisualOverview;
      try {
        if (!active.core.observeVisual)
          throw new Error("native visual observation is unavailable");
        overview = await active.core.observeVisual({
          windowRef: window.coreWindowRef,
        });
      } catch {
        throw new Error("native window screenshot could not be observed");
      }
      this.clearObservationCapabilities(active);
      const visualObservationRef = randomOpaqueId("nvobs");
      const regionBindings = new Map<string, string>();
      const regions = Object.freeze(
        overview.regions.map((region) => {
          const regionRef = randomOpaqueId("nvreg");
          regionBindings.set(regionRef, region.id);
          return Object.freeze({ regionRef, label: region.label });
        }),
      );
      active.visualOverviews.set(
        visualObservationRef,
        Object.freeze({
          windowRef: input.windowRef,
          coreOverviewId: overview.id,
          regions: regionBindings,
        }),
      );
      this.touch(active);
      return Object.freeze({
        visualObservationRef,
        windowRef: input.windowRef,
        width: overview.width,
        height: overview.height,
        image: overview.image,
        regions,
      });
    });
  }

  async visualDisclosureContext(
    input: Readonly<{ runRef: string; windowRef: string }>,
  ): Promise<NativeVisualDisclosureContext> {
    return this.mutex.runExclusive(async () => {
      const active = this.requireRun(input.runRef);
      const window = active.windows.get(input.windowRef);
      const app = window ? active.apps.get(window.publicAppRef) : undefined;
      if (!window || !app)
        throw new Error("native window reference is stale or invalid");
      this.touch(active);
      return Object.freeze({
        appLabel: app.name,
        windowLabel: window.title,
        untrustedUiData: true,
      });
    });
  }

  async refineVisual(
    input: Readonly<{
      runRef: string;
      visualObservationRef: string;
      regionRef: string;
    }>,
  ): Promise<NativePublicVisualDetail> {
    return this.mutex.runExclusive(async () => {
      const active = this.requireRun(input.runRef);
      const binding = active.visualOverviews.get(input.visualObservationRef);
      const coreRegionId = binding?.regions.get(input.regionRef);
      if (!binding || !coreRegionId)
        throw new Error(
          "native visual observation capability is stale or invalid",
        );
      let detail: NativeVisualDetail;
      try {
        if (!active.core.refineVisual)
          throw new Error("native visual refinement is unavailable");
        detail = await active.core.refineVisual({
          overviewId: binding.coreOverviewId,
          regionId: coreRegionId,
        });
      } catch {
        throw new Error("native visual observation is stale or unavailable");
      }
      this.clearObservationCapabilities(active);
      const observation = this.publishObservation(
        active,
        binding.windowRef,
        detail.observation,
      );
      this.touch(active);
      return Object.freeze({
        observation,
        width: detail.width,
        height: detail.height,
        image: detail.image,
      });
    });
  }

  async step(
    input: Readonly<{
      runRef: string;
      operationKey: string;
      observationRef: string;
      actionRef: string;
      verification: NativeVerification;
      text?: string;
      authorize?: NativeApprovalHandler;
    }>,
  ): Promise<NativeExecutionResult> {
    return this.mutex.runExclusive(async () => {
      const tombstoneKey = `${input.runRef}\0${input.operationKey}`;
      const requestDigest = createHash("sha256")
        .update(
          JSON.stringify({
            observationRef: input.observationRef,
            actionRef: input.actionRef,
            verification: input.verification,
            textDigest:
              input.text === undefined
                ? null
                : createHmac("sha256", this.approvalIdentityKey)
                    .update("jev-cua:native-step-text:v1\0", "utf8")
                    .update(input.text, "utf8")
                    .digest("hex"),
          }),
        )
        .digest("hex");
      const completed = this.stepTombstones.get(tombstoneKey);
      if (completed) {
        if (completed.requestDigest !== requestDigest)
          throw new Error("native operation key was used for another request");
        return completed.result;
      }
      const active = this.requireRun(input.runRef);
      const binding = active.actions.get(input.actionRef);
      if (
        !binding ||
        binding.observationRef !== input.observationRef ||
        !active.observations.has(input.observationRef)
      ) {
        throw new Error("native action reference is stale or invalid");
      }
      let action: NativeAction;
      if (binding.action.source === "text") {
        if (
          typeof input.text !== "string" ||
          input.text.length === 0 ||
          input.text.length > 4_000 ||
          containsRecognizableCredential(input.text)
        ) {
          throw new Error(
            "native text action requires one to 4000 characters of non-sensitive text and rejects recognizable credentials",
          );
        }
        action =
          binding.action.kind === "set_value"
            ? Object.freeze({ kind: "set_value", value: input.text })
            : Object.freeze({ kind: "type_text", text: input.text });
      } else {
        if (input.text !== undefined)
          throw new Error(
            "native text is valid only for a returned text-entry action",
          );
        action = binding.action.value;
      }
      const operationFingerprint = createHmac(
        "sha256",
        this.approvalIdentityKey,
      )
        .update("jev-cua:native-operation-display:v1\0", "utf8")
        .update(input.operationKey, "utf8")
        .digest("hex")
        .slice(0, 16);
      const authorizeConsequentialAction: NativeApprovalGate | undefined =
        binding.availability === "approval_required" && input.authorize
          ? async (request) => {
              if (
                request.operationKey !== input.operationKey ||
                request.actionKind !== action.kind ||
                request.risk !== binding.risk ||
                (request.risk !== "r2_private" &&
                  request.risk !== "r3_consequential")
              ) {
                return Object.freeze({ status: "failed" as const });
              }
              return input.authorize!(
                Object.freeze({
                  runRef: input.runRef,
                  observationRef: input.observationRef,
                  actionRef: input.actionRef,
                  operationFingerprint,
                  actionKind: action.kind,
                  actionDescription: binding.actionDescription,
                  risk: request.risk,
                  appLabel: binding.appLabel,
                  windowLabel: binding.windowLabel,
                  controlRole: binding.controlRole,
                  ...(binding.controlLabel === undefined
                    ? {}
                    : { controlLabel: binding.controlLabel }),
                  ...(action.kind === "set_value"
                    ? { text: action.value }
                    : action.kind === "type_text"
                      ? { text: action.text }
                      : {}),
                  untrustedUiData: true,
                }),
              );
            }
          : undefined;
      this.clearObservationCapabilities(active);
      this.touch(active);
      let result: NativeExecutionResult;
      try {
        result = await active.core.execute({
          operationKey: input.operationKey,
          observationId: binding.coreObservationId,
          candidateId: binding.coreCandidateId,
          action,
          verification: input.verification,
          ...(authorizeConsequentialAction
            ? { authorizeConsequentialAction }
            : {}),
        });
      } catch {
        result = Object.freeze({
          outcome: "unknown",
          reasonCode: "reconciliation_required",
          mutationAttempted: true,
          reconciliationRequired: true,
          safeToRetry: false,
          replayed: false,
        });
        await active.core.quarantine().catch(() => undefined);
        this.detach(active);
        const ended = await this.endCore(active.core);
        const cleanup = Object.freeze({
          ...ended,
          // The unexpected execution exception is uncertain even when Cua
          // session cleanup itself succeeds.
          reconciliationRequired: true,
        });
        this.recordEnd(
          active.runRef,
          cleanup,
          cleanup.cleanupSucceeded ? undefined : active.core,
        );
      }
      if (!result.safeToRetry || result.mutationAttempted) {
        this.recordStep(tombstoneKey, requestDigest, result);
      }
      return result;
    });
  }

  async end(input: Readonly<{ runRef: string }>): Promise<NativeEndResult> {
    return this.mutex.runExclusive(async () => {
      const cached = this.endTombstones.get(input.runRef);
      if (cached) {
        if (!cached.retryCore) return cached.result;
        const retried = await this.endCore(cached.retryCore);
        this.recordEnd(
          input.runRef,
          retried,
          retried.cleanupSucceeded ? undefined : cached.retryCore,
        );
        return retried;
      }
      const active = this.requireRun(input.runRef);
      this.detach(active);
      const result = await this.endCore(active.core);
      this.recordEnd(
        active.runRef,
        result,
        result.cleanupSucceeded ? undefined : active.core,
      );
      return result;
    });
  }

  async shutdown(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const active = this.active;
      if (!active) return;
      this.detach(active);
      const result = await this.endCore(active.core);
      this.recordEnd(
        active.runRef,
        result,
        result.cleanupSucceeded ? undefined : active.core,
      );
    });
  }

  private publishObservation(
    active: ActiveRun,
    windowRef: string,
    observation: NativeObservation,
  ): NativePublicObservation {
    const observationRef = randomOpaqueId("nobs");
    active.observations.add(observationRef);
    let actionLimitReached = false;
    const candidates = Object.freeze(
      observation.candidates.slice(0, MAX_PUBLIC_CANDIDATES).map((candidate) =>
        this.publishCandidate(
          active,
          observationRef,
          windowRef,
          observation,
          candidate,
          () => {
            actionLimitReached = true;
          },
        ),
      ),
    );
    return Object.freeze({
      observationRef,
      windowRef,
      complete:
        observation.complete &&
        observation.candidates.length <= MAX_PUBLIC_CANDIDATES &&
        !actionLimitReached,
      actionable: observation.actionable,
      candidateCount: candidates.length,
      candidates,
      untrustedUiData: true,
    });
  }

  private publishCandidate(
    active: ActiveRun,
    observationRef: string,
    windowRef: string,
    observation: NativeObservation,
    candidate: NativeCandidate,
    markActionLimit: () => void,
  ): NativePublicCandidate {
    const actions: NativePublicAction[] = [];
    const window = active.windows.get(windowRef);
    const app = window ? active.apps.get(window.publicAppRef) : undefined;
    if (!window || !app)
      throw new Error("native display context is stale or invalid");
    const bind = (
      action: BoundAction,
      kind: NativeActionKind,
      description: string,
      risk: RiskClass,
      availability: "allowed" | "approval_required",
    ): void => {
      if (active.actions.size >= MAX_ACTION_BINDINGS) {
        markActionLimit();
        actions.push(unavailableAction(kind, description, risk, "not_exposed"));
        return;
      }
      const actionRef = randomOpaqueId("nact");
      active.actions.set(
        actionRef,
        Object.freeze({
          observationRef,
          coreObservationId: observation.id,
          coreCandidateId: candidate.id,
          action: Object.freeze(action),
          actionDescription: description,
          risk,
          availability,
          appLabel: app.name,
          windowLabel: window.title,
          controlRole: candidate.role,
          ...(candidate.label === undefined
            ? {}
            : { controlLabel: candidate.label }),
        }),
      );
      actions.push(
        Object.freeze({
          actionRef,
          kind,
          description,
          risk,
          availability,
        }),
      );
    };

    if (candidate.actionKinds.includes("click")) {
      const risk = candidate.riskByAction.click ?? "r4_forbidden";
      if (
        (candidate.targetKind === "element" ||
          candidate.targetKind === "visual_cell") &&
        risk !== "r4_forbidden"
      ) {
        bind(
          Object.freeze({
            source: "fixed",
            value:
              candidate.targetKind === "visual_cell"
                ? Object.freeze({ kind: "click" })
                : Object.freeze({ kind: "click", activation: "press" }),
          }),
          "click",
          candidate.targetKind === "visual_cell"
            ? `Click visual grid cell ${candidate.label ?? ""}`.trim()
            : "Press this control",
          risk,
          risk === "r0_read_only" || risk === "r1_reversible"
            ? "allowed"
            : "approval_required",
        );
      } else {
        actions.push(
          unavailableAction(
            "click",
            "Press this control",
            risk,
            unavailableForRisk(risk),
          ),
        );
      }
    }

    if (candidate.actionKinds.includes("set_value")) {
      const risk = candidate.riskByAction.set_value ?? "r2_private";
      if (candidate.targetKind === "element" && risk !== "r4_forbidden") {
        bind(
          Object.freeze({ source: "text", kind: "set_value" }),
          "set_value",
          "Set non-sensitive text in this control",
          risk,
          risk === "r0_read_only" || risk === "r1_reversible"
            ? "allowed"
            : "approval_required",
        );
      } else {
        actions.push(
          unavailableAction(
            "set_value",
            "Set non-sensitive text in this control",
            risk,
            unavailableForRisk(risk),
          ),
        );
      }
    }

    if (candidate.actionKinds.includes("type_text")) {
      const risk = candidate.riskByAction.type_text ?? "r2_private";
      if (candidate.targetKind === "element" && risk !== "r4_forbidden") {
        bind(
          Object.freeze({ source: "text", kind: "type_text" }),
          "type_text",
          "Type non-sensitive text in this control",
          risk,
          risk === "r0_read_only" || risk === "r1_reversible"
            ? "allowed"
            : "approval_required",
        );
      } else {
        actions.push(
          unavailableAction(
            "type_text",
            "Type non-sensitive text in this control",
            risk,
            unavailableForRisk(risk),
          ),
        );
      }
    }

    if (candidate.actionKinds.includes("press_key")) {
      const risk = candidate.riskByAction.press_key ?? "r4_forbidden";
      if (risk !== "r4_forbidden") {
        for (const key of SAFE_KEYS) {
          bind(
            Object.freeze({
              source: "fixed",
              value: Object.freeze({ kind: "press_key", key: key.key }),
            }),
            "press_key",
            key.description,
            risk,
            risk === "r0_read_only" || risk === "r1_reversible"
              ? "allowed"
              : "approval_required",
          );
        }
        for (const key of APPROVAL_KEYS) {
          const keyRisk: RiskClass =
            risk === "r3_consequential" ? risk : "r2_private";
          bind(
            Object.freeze({
              source: "fixed",
              value: Object.freeze({ kind: "press_key", key: key.key }),
            }),
            "press_key",
            key.description,
            keyRisk,
            "approval_required",
          );
        }
      } else {
        actions.push(
          unavailableAction(
            "press_key",
            "Press a navigation key",
            risk,
            "denied",
          ),
        );
      }
    }

    if (candidate.actionKinds.includes("invoke_menu")) {
      const risk = candidate.riskByAction.invoke_menu ?? "r4_forbidden";
      if (candidate.targetKind === "element" && risk !== "r4_forbidden") {
        bind(
          Object.freeze({
            source: "fixed",
            value: Object.freeze({ kind: "invoke_menu" }),
          }),
          "invoke_menu",
          "Choose this exact menu item",
          risk,
          risk === "r0_read_only" || risk === "r1_reversible"
            ? "allowed"
            : "approval_required",
        );
      } else {
        actions.push(
          unavailableAction(
            "invoke_menu",
            "Choose this exact menu item",
            risk,
            unavailableForRisk(risk),
          ),
        );
      }
    }

    if (candidate.targetKind === "window") {
      if (candidate.actionKinds.includes("scroll")) {
        const risk = candidate.riskByAction.scroll ?? "r4_forbidden";
        if (risk === "r1_reversible") {
          for (const scroll of SAFE_SCROLLS) {
            bind(
              Object.freeze({
                source: "fixed",
                value: Object.freeze({
                  kind: "scroll",
                  direction: scroll.direction,
                  by: "line",
                  amount: 3,
                }),
              }),
              "scroll",
              scroll.description,
              risk,
              "allowed",
            );
          }
        } else {
          actions.push(
            unavailableAction(
              "scroll",
              "Scroll this window",
              risk,
              unavailableForRisk(risk),
            ),
          );
        }
      }
    }

    return Object.freeze({
      candidateRef: randomOpaqueId("npcand"),
      targetKind: candidate.targetKind,
      role: candidate.role,
      ...(candidate.label === undefined ? {} : { label: candidate.label }),
      valuePresent: candidate.valuePresent,
      ...(candidate.enabled === undefined
        ? {}
        : { enabled: candidate.enabled }),
      ...(candidate.selected === undefined
        ? {}
        : { selected: candidate.selected }),
      actions: Object.freeze(actions),
      untrustedText: true,
    });
  }

  private requireRun(runRef: string): ActiveRun {
    const active = this.active;
    if (!active || active.runRef !== runRef)
      throw new Error("native run reference is stale or invalid");
    return active;
  }

  private clearObservationCapabilities(active: ActiveRun): void {
    active.actions.clear();
    active.observations.clear();
    active.visualOverviews.clear();
  }

  private clearWindowCapabilities(active: ActiveRun): void {
    this.clearObservationCapabilities(active);
    active.windows.clear();
  }

  private touch(active: ActiveRun): void {
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = setTimeout(() => {
      void this.expire(active.runRef);
    }, this.idleTtlMs);
    active.idleTimer.unref();
  }

  private async expire(runRef: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const active = this.active;
      if (!active || active.runRef !== runRef) return;
      this.detach(active);
      const result = await this.endCore(active.core);
      this.recordEnd(
        active.runRef,
        result,
        result.cleanupSucceeded ? undefined : active.core,
      );
    });
  }

  private recordEnd(
    runRef: string,
    result: NativeEndResult,
    retryCore?: NativeCoreFacade,
  ): void {
    this.endTombstones.delete(runRef);
    this.endTombstones.set(
      runRef,
      Object.freeze({
        result: Object.freeze({ ...result }),
        ...(retryCore ? { retryCore } : {}),
      }),
    );
    while (this.endTombstones.size > MAX_END_TOMBSTONES) {
      const oldest = [...this.endTombstones].find(
        ([, tombstone]) => !tombstone.retryCore,
      )?.[0];
      if (oldest === undefined) break;
      this.endTombstones.delete(oldest);
    }
  }

  private async endCore(core: NativeCoreFacade): Promise<NativeEndResult> {
    let result: NativeEndResult = Object.freeze({
      cleanupSucceeded: false,
      reconciliationRequired: true,
    });
    // One immediate retry lets a retryable DesktopLease release recover from
    // a transient filesystem failure before the public end result is cached.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await core.end();
      } catch {
        result = Object.freeze({
          cleanupSucceeded: false,
          reconciliationRequired: true,
        });
      }
      if (result.cleanupSucceeded) break;
    }
    return result;
  }

  private recordStep(
    key: string,
    requestDigest: string,
    result: NativeExecutionResult,
  ): void {
    this.stepTombstones.delete(key);
    this.stepTombstones.set(
      key,
      Object.freeze({ requestDigest, result: Object.freeze({ ...result }) }),
    );
    while (this.stepTombstones.size > MAX_STEP_TOMBSTONES) {
      const oldest = this.stepTombstones.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.stepTombstones.delete(oldest);
    }
  }

  private detach(active: ActiveRun): void {
    if (active.idleTimer) clearTimeout(active.idleTimer);
    delete active.idleTimer;
    this.clearWindowCapabilities(active);
    active.apps.clear();
    if (this.active === active) this.active = undefined;
  }
}
