import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { DriverToolError } from "../cua/client.js";
import {
  classifyLabelRisk,
  riskMayExecuteAutomatically,
} from "../policy/risk.js";
import { DesktopLease, LiveExecutionBarrier, RunStore } from "../state.js";
import type { DriverClient, JsonValue, RiskClass } from "../types.js";
import {
  AsyncMutex,
  asRecord,
  randomOpaqueId,
  redactProviderText,
  truncateUntrusted,
} from "../util.js";
import { NativeOperationStore } from "./operation-store.js";
import {
  assertExactLaunchCapability,
  parseLaunchReceipt,
  verifyLaunchedIdentity,
} from "./lifecycle.js";
import {
  assertExactVisualFreshness,
  bindNormalizedVisualPoint,
  createOpaqueVisualGrid,
  validateCuaWindowScreenshot,
  validateCuaZoomScreenshot,
  type NativeVisualCapture,
  type NativeVisualPointBinding,
  type NativeVisualZoomCapture,
  type NormalizedVisualPoint,
} from "./visual.js";
import type {
  NativeAction,
  NativeActionKind,
  NativeAppSummary,
  NativeApprovalDecision,
  NativeApprovalGate,
  NativeApprovalRequest,
  NativeCandidate,
  NativeEndResult,
  NativeExecutionOutcome,
  NativeExecutionResult,
  NativeLaunchResult,
  NativeObservation,
  NativeVerification,
  NativeVisualDetail,
  NativeVisualOverview,
  NativeWindowSummary,
  NativeWindowTarget,
} from "./types.js";

const REQUIRED_TOOLS = new Set([
  "start_session",
  "end_session",
  "list_apps",
  "list_windows",
  "get_window_state",
  "launch_app",
  "zoom",
  "click",
  "type_text",
  "set_value",
  "press_key",
  "scroll",
  "invoke_menu",
  "verify_state",
]);

const ROUTES = new Set([
  "accessibility",
  "synthetic_events",
  "global_input",
  "system_api",
  "dom",
  "trusted_input",
]);

const CLICK_ACTIONS = new Map<string, NativeClickActivation>([
  ["AXPress", "press"],
  ["AXShowMenu", "show_menu"],
  ["AXPick", "pick"],
  ["AXConfirm", "confirm"],
  ["AXCancel", "cancel"],
  ["AXOpen", "open"],
]);

const SAFE_KEYS = new Set([
  "escape",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

const TEXT_CONTROL_ROLE = /(?:Text(?:Field|Area)|SearchField|ComboBox)$/iu;
const KEY_TARGET_ROLE =
  /(?:Text(?:Field|Area)|SearchField|ComboBox|PopUpButton|List|Table|Outline|Tree|TabGroup|Slider|Incrementor|ScrollArea|WebArea)$/iu;
const MENU_ITEM_ROLE = /(?:^|\b)AXMenuItem$/u;
const MENU_BAR_ITEM_ROLE = /(?:^|\b)AXMenuBarItem$/u;
const MENU_CONTAINER_ROLE = /(?:^|\b)AXMenu$/u;
const MENU_BAR_ROLE = /(?:^|\b)AXMenuBar$/u;
const APPLE_MENU_LABEL = /^(?:apple|\uF8FF)$/iu;
const UNSAFE_MENU_BRANCH =
  /^(?:services|recent items|open recent|share|speech)$/iu;
const UNSAFE_MENU_LEAF =
  /^(?:close(?: window)?|force quit(?:\u2026|\.\.\.)?|quit(?: .+)?|restart(?:\u2026|\.\.\.)?|shut ?down(?:\u2026|\.\.\.)?|sleep|lock screen|log ?out(?: .+)?(?:\u2026|\.\.\.)?)$/iu;

// A general UI label is not authority to mutate. Unknown AXPress controls are
// consequential by default because bland labels such as "Continue" can submit
// forms or commit remote state. Native mode automatically binds only this
// narrow set of locally reversible controls; broader actions need an approval
// path or a reviewed compiled workflow.
const APPLE_CALCULATOR_PATH = "/System/Applications/Calculator.app";
const CALCULATOR_REVERSIBLE_CLICK_LABELS = Object.freeze([
  /^(?:[0-9]|zero|one|two|three|four|five|six|seven|eight|nine)$/iu,
  /^(?:\+|-|−|×|÷|=|\.|,|%|add|subtract|multiply|divide|equals?|decimal|point|percent|per cent|plus\/minus|positive negative|change sign|clear|all clear)$/iu,
  /^hide sidebar$/iu,
]);

function clickIsLocallyReversible(
  target: ExactWindowTarget,
  element: ParsedElement,
  label: string,
): boolean {
  if (
    target.bundleId === "com.apple.calculator" &&
    target.launchPath === APPLE_CALCULATOR_PATH &&
    CALCULATOR_REVERSIBLE_CLICK_LABELS.some((pattern) => pattern.test(label))
  ) {
    return true;
  }
  // Accessibility roles and labels are app-controlled. Native mode therefore
  // grants no generic AXPress authority without a reviewed app identity.
  void element;
  return false;
}

type NativeClickActivation = NonNullable<
  Extract<NativeAction, { kind: "click" }>["activation"]
>;

type ParsedApp = Readonly<{
  bundleId: string;
  launchPath: string | null;
  name: string;
  running: boolean;
  active: boolean;
  pid: number;
}>;

type ParsedWindow = Readonly<{
  pid: number;
  windowId: number;
  title: string;
  onScreen: boolean;
  onCurrentSpace: boolean | null;
  minimized: boolean | null;
}>;

type ParsedElement = Readonly<{
  index: number;
  token: string;
  role: string;
  label: string | null;
  value: string | null;
  actions: readonly string[];
  enabled: boolean | null;
  selected: boolean | null;
  parentIndex: number | null;
}>;

type ExactWindowTarget = Readonly<{
  bundleId: string;
  launchPath: string | null;
  pid: number;
  windowId: number;
}>;

type AppCapability = Readonly<{
  bundleId: string;
  launchPath: string | null;
  name: string;
  running: boolean;
  active: boolean;
  pid: number;
}>;

type WindowCapability = Readonly<{
  appRef: string;
  target: ExactWindowTarget;
}>;

type CapturedWindow = Readonly<{
  target: ExactWindowTarget;
  appName: string;
  complete: boolean;
  actionable: boolean;
  elements: readonly ParsedElement[];
}>;

type CandidateBinding = Readonly<{
  observationId: string;
  target: ExactWindowTarget;
  publicTarget: NativeWindowTarget;
  targetKind: "window" | "element" | "visual_cell";
  role: string;
  label: string | null;
  elementIndex: number | null;
  identityDigest: string;
  menuPath: readonly string[] | null;
  visualPoint: NativeVisualPointBinding | null;
  visualRootCapture: NativeVisualCapture | null;
  visualZoomBounds: Readonly<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> | null;
  visualZoomCapture: NativeVisualZoomCapture | null;
  actionKinds: readonly NativeActionKind[];
  clickActivations: readonly NativeClickActivation[];
  riskByAction: Readonly<Partial<Record<NativeActionKind, RiskClass>>>;
}>;

type VisualOverviewRecord = Readonly<{
  target: ExactWindowTarget;
  publicTarget: NativeWindowTarget;
  capture: NativeVisualCapture;
  regions: ReadonlyMap<string, NormalizedVisualPoint>;
}>;

type VisualRebind = Readonly<{
  kind: "visual";
  point: NativeVisualPointBinding;
}>;

type ObservationRecord = Readonly<{
  targetKey: string;
  candidateIds: readonly string[];
}>;

type NativeReceipt = Readonly<{
  effect: "confirmed" | "unverifiable";
  route:
    | "accessibility"
    | "synthetic_events"
    | "global_input"
    | "system_api"
    | "dom"
    | "trusted_input";
}>;

function targetKey(target: ExactWindowTarget): string {
  return `${target.bundleId}\0${target.launchPath ?? ""}\0${target.pid}\0${target.windowId}`;
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safeUiText(value: string, maximum = 200): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUntrusted(redactProviderText(normalized), maximum);
}

function assertTarget(target: ExactWindowTarget): void {
  if (
    typeof target.bundleId !== "string" ||
    !target.bundleId.trim() ||
    target.bundleId.length > 512 ||
    (target.launchPath !== null &&
      (typeof target.launchPath !== "string" ||
        !target.launchPath.startsWith("/") ||
        target.launchPath.length > 4_096)) ||
    !validPositiveInteger(target.pid) ||
    !validPositiveInteger(target.windowId)
  ) {
    throw new Error("native window target is invalid");
  }
}

function parseApps(output: Record<string, unknown>): readonly ParsedApp[] {
  if (!Array.isArray(output.apps))
    throw new Error("Cua app inventory is malformed");
  return Object.freeze(
    output.apps.flatMap((entry): ParsedApp[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const app = entry as Record<string, unknown>;
      if (
        typeof app.bundle_id !== "string" ||
        !app.bundle_id ||
        typeof app.name !== "string" ||
        typeof app.running !== "boolean" ||
        typeof app.active !== "boolean" ||
        !Number.isSafeInteger(app.pid) ||
        Number(app.pid) < 0
      ) {
        return [];
      }
      return [
        Object.freeze({
          bundleId: app.bundle_id,
          launchPath:
            typeof app.launch_path === "string" &&
            app.launch_path.startsWith("/") &&
            app.launch_path.length <= 4_096
              ? app.launch_path
              : null,
          name: app.name,
          running: app.running,
          active: app.active,
          pid: Number(app.pid),
        }),
      ];
    }),
  );
}

function parseWindows(
  output: Record<string, unknown>,
): readonly ParsedWindow[] {
  if (!Array.isArray(output.windows))
    throw new Error("Cua window inventory is malformed");
  return Object.freeze(
    output.windows.flatMap((entry): ParsedWindow[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const window = entry as Record<string, unknown>;
      if (
        !validPositiveInteger(window.pid) ||
        !validPositiveInteger(window.window_id) ||
        typeof window.title !== "string" ||
        typeof window.is_on_screen !== "boolean"
      ) {
        return [];
      }
      return [
        Object.freeze({
          pid: window.pid,
          windowId: window.window_id,
          title: window.title,
          onScreen: window.is_on_screen,
          onCurrentSpace: nullableBoolean(window.on_current_space),
          minimized: nullableBoolean(window.minimized),
        }),
      ];
    }),
  );
}

function parseElements(
  output: Record<string, unknown>,
): readonly ParsedElement[] {
  if (!Array.isArray(output.elements)) return Object.freeze([]);
  return Object.freeze(
    output.elements.flatMap((entry): ParsedElement[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const element = entry as Record<string, unknown>;
      if (
        !Number.isSafeInteger(element.element_index) ||
        Number(element.element_index) < 0 ||
        typeof element.element_token !== "string" ||
        !element.element_token ||
        typeof element.role !== "string" ||
        !element.role
      ) {
        return [];
      }
      const actions = Array.isArray(element.actions)
        ? element.actions.filter(
            (action): action is string => typeof action === "string",
          )
        : [];
      return [
        Object.freeze({
          index: Number(element.element_index),
          token: element.element_token,
          role: element.role,
          label: typeof element.label === "string" ? element.label : null,
          value: typeof element.value === "string" ? element.value : null,
          actions: Object.freeze(actions),
          enabled: nullableBoolean(element.enabled),
          selected: nullableBoolean(element.selected),
          parentIndex: Number.isSafeInteger(element.parent_index)
            ? Number(element.parent_index)
            : null,
        }),
      ];
    }),
  );
}

/**
 * Cua documents `elements_complete: false` as a healthy projection on some
 * platforms. A projection is still safe for this facade's narrowly known
 * reversible controls when the exact window and Accessibility route are
 * attested, every returned element is structurally valid, the walk was not
 * degraded/truncated, and all published counts agree. We never use projection
 * absence as proof; execution rebinds the exact internal index + semantic path
 * and then requires a positive deterministic postcondition.
 */
function captureIsActionable(
  output: Record<string, unknown>,
  target: ExactWindowTarget,
  elements: readonly ParsedElement[],
): boolean {
  if (
    output.degraded === true ||
    output.truncated === true ||
    typeof output.snapshot_id !== "string" ||
    output.snapshot_id.length === 0 ||
    !Array.isArray(output.elements) ||
    elements.length !== output.elements.length
  ) {
    return false;
  }
  for (const count of [
    output.element_count,
    output.returned_element_count,
    output.total_element_count,
  ]) {
    if (!Number.isSafeInteger(count) || Number(count) !== elements.length)
      return false;
  }
  const background =
    output.background_input &&
    typeof output.background_input === "object" &&
    !Array.isArray(output.background_input)
      ? (output.background_input as Record<string, unknown>)
      : undefined;
  const exact =
    background?.exact_window &&
    typeof background.exact_window === "object" &&
    !Array.isArray(background.exact_window)
      ? (background.exact_window as Record<string, unknown>)
      : undefined;
  const accessibilityAvailable = Array.isArray(background?.routes)
    ? background.routes.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).route === "accessibility" &&
          (entry as Record<string, unknown>).status === "available",
      )
    : false;
  return (
    exact?.status === "matched" &&
    exact.pid === target.pid &&
    exact.window_id === target.windowId &&
    accessibilityAvailable
  );
}

function clickActivations(
  element: ParsedElement,
): readonly NativeClickActivation[] {
  return Object.freeze(
    element.actions.flatMap((action): NativeClickActivation[] => {
      const mapped = CLICK_ACTIONS.get(action);
      return mapped ? [mapped] : [];
    }),
  );
}

function exactMenuLabel(value: string | null): string | undefined {
  if (value === null) return undefined;
  const label = value.trim();
  if (label.length < 1 || label.length > 200 || /[\p{Cc}\p{Cf}]/u.test(label)) {
    return undefined;
  }
  return label;
}

/**
 * Turn AX menu leaves into exact, local-only menu capabilities. The first
 * menu-bar branch is excluded even if its label is absent or localized: on
 * macOS it is the Apple menu and can contain host-wide power/session actions.
 * Other unsafe branches and leaves are omitted instead of merely relying on a
 * caller to notice their risk classification.
 */
function menuPaths(
  elements: readonly ParsedElement[],
  appName: string,
): ReadonlyMap<number, readonly string[]> {
  const byIndex = new Map(elements.map((element) => [element.index, element]));
  const children = new Map<number, ParsedElement[]>();
  for (const element of elements) {
    if (element.parentIndex === null) continue;
    const siblings = children.get(element.parentIndex) ?? [];
    siblings.push(element);
    children.set(element.parentIndex, siblings);
  }
  // On macOS the first two menu-bar branches are the Apple and application
  // menus. Omit both structurally: app inventory names are not guaranteed to
  // equal the localized/abbreviated application-menu title.
  const reservedMenuRoots = new Set(
    elements
      .filter((element) => MENU_BAR_ITEM_ROLE.test(element.role))
      .slice(0, 2)
      .map((element) => element.index),
  );
  const applicationMenuLabel = exactMenuLabel(appName)?.normalize("NFKC");
  const result = new Map<number, readonly string[]>();
  for (const leaf of elements) {
    if (
      !MENU_ITEM_ROLE.test(leaf.role) ||
      leaf.enabled === false ||
      !leaf.actions.includes("AXPress") ||
      (children.get(leaf.index) ?? []).some((child) =>
        MENU_CONTAINER_ROLE.test(child.role),
      )
    ) {
      continue;
    }
    const reversed: string[] = [];
    const seen = new Set<number>();
    let current: ParsedElement | undefined = leaf;
    let rootIndex: number | undefined;
    let structurallyValid = true;
    while (current) {
      if (seen.has(current.index)) {
        structurallyValid = false;
        break;
      }
      seen.add(current.index);
      if (MENU_ITEM_ROLE.test(current.role)) {
        const label = exactMenuLabel(current.label);
        if (!label) {
          structurallyValid = false;
          break;
        }
        reversed.push(label);
      } else if (MENU_BAR_ITEM_ROLE.test(current.role)) {
        const label = exactMenuLabel(current.label);
        if (!label) {
          structurallyValid = false;
          break;
        }
        reversed.push(label);
        rootIndex = current.index;
        break;
      } else if (
        !MENU_CONTAINER_ROLE.test(current.role) &&
        !MENU_BAR_ROLE.test(current.role)
      ) {
        structurallyValid = false;
        break;
      }
      current =
        current.parentIndex === null
          ? undefined
          : byIndex.get(current.parentIndex);
    }
    if (!structurallyValid || rootIndex === undefined) continue;
    const path = reversed.reverse();
    if (
      path.length < 2 ||
      path.length > 16 ||
      reservedMenuRoots.has(rootIndex) ||
      APPLE_MENU_LABEL.test(path[0]!) ||
      (applicationMenuLabel !== undefined &&
        path[0]!.normalize("NFKC") === applicationMenuLabel) ||
      path.some((part) => UNSAFE_MENU_BRANCH.test(part)) ||
      UNSAFE_MENU_LEAF.test(path.at(-1)!) ||
      classifyLabelRisk(path.join(" > ")) === "r4_forbidden"
    ) {
      continue;
    }
    result.set(leaf.index, Object.freeze(path));
  }
  return result;
}

function actionKindsForElement(
  element: ParsedElement,
  menuPath?: readonly string[],
): readonly NativeActionKind[] {
  const kinds: NativeActionKind[] = [];
  if (MENU_ITEM_ROLE.test(element.role)) {
    if (menuPath) kinds.push("invoke_menu");
    return Object.freeze(kinds);
  }
  if (MENU_BAR_ITEM_ROLE.test(element.role)) return Object.freeze(kinds);
  // The public native facade binds click actions to AXPress. Do not advertise
  // a generic click for menu-only/pick-only controls, because the caller must
  // never choose an executable AX action string.
  if (clickActivations(element).includes("press")) kinds.unshift("click");
  if (
    !/Secure/iu.test(element.role) &&
    element.value !== null &&
    TEXT_CONTROL_ROLE.test(element.role)
  ) {
    kinds.push("set_value");
    kinds.push("type_text");
  }
  if (!/Secure/iu.test(element.role) && KEY_TARGET_ROLE.test(element.role))
    kinds.push("press_key");
  return Object.freeze([...new Set(kinds)]);
}

function assertVerification(verification: NativeVerification): void {
  if (
    !verification ||
    !Array.isArray(verification.expect) ||
    verification.expect.length < 1 ||
    verification.expect.length > 8
  ) {
    throw new Error("native verification must contain one to eight predicates");
  }
  if (
    verification.timeoutMs !== undefined &&
    (!Number.isInteger(verification.timeoutMs) ||
      verification.timeoutMs < 0 ||
      verification.timeoutMs > 10_000)
  ) {
    throw new Error("native verification timeout is invalid");
  }
  if (
    verification.stableSamples !== undefined &&
    (!Number.isInteger(verification.stableSamples) ||
      verification.stableSamples < 1 ||
      verification.stableSamples > 5)
  ) {
    throw new Error("native verification stability sample count is invalid");
  }
  for (const predicate of verification.expect) {
    if (!predicate || typeof predicate !== "object")
      throw new Error("native verification predicate is invalid");
    if ("window" in predicate) {
      if (
        Object.keys(predicate).length !== 1 ||
        !predicate.window ||
        typeof predicate.window.exists !== "boolean"
      ) {
        throw new Error("native window predicate is invalid");
      }
      continue;
    }
    if (!("element" in predicate) || Object.keys(predicate).length !== 1)
      throw new Error("native element predicate is invalid");
    const element = predicate.element;
    const { role, labelContains } = element.selector;
    const hasAssertion =
      element.exists === true ||
      element.enabled !== undefined ||
      element.selected !== undefined ||
      element.valueEquals !== undefined;
    if (
      (role === undefined && labelContains === undefined) ||
      !hasAssertion ||
      (role !== undefined && (!role.trim() || role.length > 200)) ||
      (labelContains !== undefined &&
        (!labelContains.trim() || labelContains.length > 200)) ||
      (element.exists !== undefined && element.exists !== true) ||
      (element.valueEquals !== undefined &&
        element.valueEquals !== null &&
        element.valueEquals.length > 10_000)
    ) {
      throw new Error("native element predicate is invalid");
    }
  }
}

function verificationArguments(
  target: ExactWindowTarget,
  session: string,
  verification: NativeVerification,
): Record<string, JsonValue> {
  assertVerification(verification);
  const expect: JsonValue[] = verification.expect.map((predicate) => {
    if ("window" in predicate) {
      return { window: { exists: predicate.window.exists } };
    }
    const selector: Record<string, JsonValue> = {};
    if (predicate.element.selector.role !== undefined)
      selector.role = predicate.element.selector.role;
    if (predicate.element.selector.labelContains !== undefined)
      selector.label_contains = predicate.element.selector.labelContains;
    const element: Record<string, JsonValue> = { selector };
    if (predicate.element.exists !== undefined) element.exists = true;
    if (predicate.element.enabled !== undefined)
      element.enabled = predicate.element.enabled;
    if (predicate.element.selected !== undefined)
      element.selected = predicate.element.selected;
    if (predicate.element.valueEquals !== undefined)
      element.value_equals = predicate.element.valueEquals;
    return { element };
  });
  return {
    pid: target.pid,
    window_id: target.windowId,
    session,
    expect,
    timeout_ms: verification.timeoutMs ?? 5_000,
    stable_samples: verification.stableSamples ?? 2,
    include_screenshot: false,
  };
}

function riskRank(risk: RiskClass): number {
  return [
    "r0_read_only",
    "r1_reversible",
    "r2_private",
    "r3_consequential",
    "r4_forbidden",
  ].indexOf(risk);
}

function maximumRisk(left: RiskClass, right: RiskClass): RiskClass {
  return riskRank(left) >= riskRank(right) ? left : right;
}

function riskByActionForElement(
  target: ExactWindowTarget,
  element: ParsedElement,
  menuPath?: readonly string[],
): Readonly<Partial<Record<NativeActionKind, RiskClass>>> {
  const label = safeUiText(element.label ?? element.role);
  const classifiedLabelRisk = classifyLabelRisk(label);
  const clickRisk: RiskClass =
    classifiedLabelRisk !== "r1_reversible"
      ? classifiedLabelRisk
      : clickIsLocallyReversible(target, element, label)
        ? "r1_reversible"
        : "r3_consequential";
  const risks: Partial<Record<NativeActionKind, RiskClass>> = {};
  const kinds = actionKindsForElement(element, menuPath);
  if (kinds.includes("click")) risks.click = clickRisk;
  if (kinds.includes("set_value"))
    risks.set_value = maximumRisk(classifiedLabelRisk, "r2_private");
  if (kinds.includes("type_text"))
    risks.type_text = maximumRisk(classifiedLabelRisk, "r2_private");
  if (kinds.includes("press_key"))
    risks.press_key = maximumRisk(classifiedLabelRisk, "r1_reversible");
  if (kinds.includes("invoke_menu")) {
    const pathRisk = classifyLabelRisk(
      safeUiText((menuPath ?? []).join(" > ")),
    );
    // Exact menu invocation is powerful even when its app-provided label looks
    // harmless. Unknown menu commands therefore need one-shot approval.
    risks.invoke_menu = maximumRisk(pathRisk, "r3_consequential");
  }
  return Object.freeze(risks);
}

function actionRisk(
  action: NativeAction,
  binding: CandidateBinding,
): RiskClass {
  let risk = binding.riskByAction[action.kind] ?? "r4_forbidden";
  if (
    action.kind === "press_key" &&
    (action.modifiers?.length || !SAFE_KEYS.has(action.key.toLowerCase()))
  ) {
    risk = maximumRisk(risk, "r2_private");
  }
  if (action.kind === "invoke_menu") {
    risk = maximumRisk(
      risk,
      classifyLabelRisk(safeUiText((binding.menuPath ?? []).join(" > "))),
    );
  }
  return risk;
}

function validateAction(action: NativeAction): void {
  if (!action || typeof action !== "object")
    throw new Error("native action is invalid");
  switch (action.kind) {
    case "click":
      if (
        action.activation !== undefined &&
        !["press", "show_menu", "pick", "confirm", "cancel", "open"].includes(
          action.activation,
        )
      )
        throw new Error("native click activation is invalid");
      return;
    case "type_text":
      if (typeof action.text !== "string" || action.text.length > 10_000)
        throw new Error("native text action is invalid");
      return;
    case "set_value":
      if (typeof action.value !== "string" || action.value.length > 10_000)
        throw new Error("native value action is invalid");
      return;
    case "press_key": {
      const key = action.key.toLowerCase();
      if (
        !/^(?:return|tab|escape|up|down|left|right|space|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2])|[a-z0-9])$/u.test(
          key,
        )
      )
        throw new Error("native key action is invalid");
      if (
        action.modifiers &&
        (action.modifiers.length > 6 ||
          new Set(action.modifiers).size !== action.modifiers.length ||
          action.modifiers.some(
            (modifier) =>
              !["cmd", "shift", "option", "alt", "ctrl", "fn"].includes(
                modifier,
              ),
          ))
      )
        throw new Error("native key modifiers are invalid");
      return;
    }
    case "scroll":
      if (!["up", "down", "left", "right"].includes(action.direction))
        throw new Error("native scroll direction is invalid");
      if (
        action.by !== undefined &&
        action.by !== "line" &&
        action.by !== "page"
      )
        throw new Error("native scroll unit is invalid");
      if (
        action.amount !== undefined &&
        (!Number.isInteger(action.amount) ||
          action.amount < 1 ||
          action.amount > 50)
      )
        throw new Error("native scroll amount is invalid");
      return;
    case "invoke_menu":
      if (Object.keys(action).length !== 1)
        throw new Error("native menu path is invalid");
      return;
  }
}

function parseNativeReceipt(
  action: NativeAction,
  output: Record<string, unknown>,
  pixelClick = false,
): NativeReceipt {
  if (output.effect !== "confirmed" && output.effect !== "unverifiable")
    throw new DriverToolError(
      "native_action",
      true,
      "native action returned no supported dispatch receipt",
    );
  if (!ROUTES.has(String(output.route)))
    throw new DriverToolError(
      "native_action",
      true,
      "native action returned an unsupported delivery route",
    );
  const expectedRoutes: ReadonlySet<string> =
    (action.kind === "click" && !pixelClick) ||
    action.kind === "set_value" ||
    action.kind === "invoke_menu"
      ? new Set(["accessibility"])
      : action.kind === "type_text"
        ? new Set(["accessibility", "synthetic_events"])
        : new Set(["synthetic_events"]);
  if (!expectedRoutes.has(String(output.route)))
    throw new DriverToolError(
      "native_action",
      true,
      "native action silently changed its delivery route",
    );
  const delivery =
    output.delivery &&
    typeof output.delivery === "object" &&
    !Array.isArray(output.delivery)
      ? (output.delivery as Record<string, unknown>)
      : undefined;
  const expectedDeliveryMode =
    output.route === "synthetic_events" ? "background" : "not_applicable";
  if (!delivery || delivery.mode !== expectedDeliveryMode)
    throw new DriverToolError(
      "native_action",
      true,
      "native action did not preserve background delivery",
    );
  if (
    output.effect === "confirmed" &&
    (!Array.isArray(output.evidence) || output.evidence.length === 0)
  ) {
    throw new DriverToolError(
      "native_action",
      true,
      "native action returned an unsupported confirmation receipt",
    );
  }
  return Object.freeze({
    effect: output.effect,
    route: output.route as NativeReceipt["route"],
  });
}

function replayResult(outcome: NativeExecutionOutcome): NativeExecutionResult {
  return Object.freeze({
    outcome,
    reasonCode: "idempotent_replay",
    mutationAttempted: true,
    reconciliationRequired: outcome !== "verified",
    safeToRetry: false,
    replayed: true,
  });
}

/**
 * A per-task native computer-use run. One named Cua session and one desktop
 * lease remain live until end(). UI-derived executable capabilities never
 * leave this object: callers receive only random candidate IDs.
 */
export class NativeComputerUseCore {
  readonly runId: string;

  private readonly session: string;
  private readonly identityKey = randomBytes(32);
  private readonly mutex = new AsyncMutex();
  private readonly apps = new Map<string, AppCapability>();
  private readonly windows = new Map<string, WindowCapability>();
  private readonly candidates = new Map<string, CandidateBinding>();
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly visualOverviews = new Map<string, VisualOverviewRecord>();
  private readonly currentObservationByTarget = new Map<string, string>();
  private readonly executionTombstones = new Map<
    string,
    Readonly<{ requestDigest: string; result: NativeExecutionResult }>
  >();
  private readonly launchTombstones = new Map<
    string,
    Readonly<{ requestDigest: string; result: NativeLaunchResult }>
  >();
  private releaseLease: (() => Promise<void>) | undefined;
  private started = false;
  private ended = false;
  private barrierMarked = false;
  private poisoned = false;
  private endBaseCleanupSucceeded: boolean | undefined;

  constructor(
    private readonly dependencies: Readonly<{
      driver: DriverClient;
      lease: DesktopLease;
      executionBarrier: LiveExecutionBarrier;
      safetyRuns: RunStore;
      operations: NativeOperationStore;
      runId?: string;
    }>,
  ) {
    this.runId = dependencies.runId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(this.runId))
      throw new Error("native run ID is invalid");
    this.session = `jev-cua-native-${randomBytes(8).toString("hex")}`;
  }

  async listApps(): Promise<readonly NativeAppSummary[]> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const apps = await this.readApps();
      this.apps.clear();
      this.windows.clear();
      this.clearObservations();
      return Object.freeze(
        apps.map((app) => {
          const appRef = randomOpaqueId("napp");
          this.apps.set(
            appRef,
            Object.freeze({
              bundleId: app.bundleId,
              launchPath: app.launchPath,
              name: app.name,
              running: app.running,
              active: app.active,
              pid: app.pid,
            }),
          );
          return Object.freeze({
            appRef,
            bundleId: app.bundleId,
            name: safeUiText(app.name),
            running: app.running,
            active: app.active,
            launchable: !app.running && app.launchPath !== null,
            untrustedText: true as const,
          });
        }),
      );
    });
  }

  async launchApp(
    input: Readonly<{
      appRef: string;
      operationKey: string;
    }>,
  ): Promise<NativeLaunchResult> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const capability = this.apps.get(input.appRef);
      if (!capability)
        throw new Error("native app capability is stale or invalid");
      const requestDigest = createHmac("sha256", this.identityKey)
        .update("jev-cua:native-launch-call:v1\0", "utf8")
        .update(
          JSON.stringify({
            appRef: input.appRef,
            bundleId: capability.bundleId,
            launchPath: capability.launchPath,
          }),
          "utf8",
        )
        .digest("hex");
      const prior = this.launchTombstones.get(input.operationKey);
      if (prior) {
        if (prior.requestDigest !== requestDigest)
          throw new Error("native operation key was used for another request");
        return prior.result;
      }
      if (this.poisoned) {
        return this.rememberLaunch(
          input.operationKey,
          requestDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "reconciliation_required",
            mutationAttempted: false,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: false,
          }),
        );
      }

      const inventory = await this.readApps();
      const alreadyRunning = inventory.filter(
        (app) =>
          app.bundleId === capability.bundleId &&
          app.launchPath === capability.launchPath &&
          app.running,
      );
      if (alreadyRunning.length === 1) {
        const app = alreadyRunning[0]!;
        this.apps.set(input.appRef, Object.freeze({ ...app }));
        return this.rememberLaunch(
          input.operationKey,
          requestDigest,
          Object.freeze({
            outcome: "denied",
            reasonCode: "app_already_running",
            app: this.appSummary(input.appRef, app),
            mutationAttempted: false,
            reconciliationRequired: false,
            safeToRetry: false,
            replayed: false,
          }),
        );
      }
      try {
        assertExactLaunchCapability(capability, inventory);
      } catch {
        return Object.freeze({
          outcome: "unknown",
          reasonCode: "stale_app",
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: true,
          replayed: false,
        });
      }

      const requestIdentity = JSON.stringify({
        schema: "jev-cua.native-launch-request.v1",
        runId: this.runId,
        bundleId: capability.bundleId,
        launchPath: capability.launchPath,
      });
      const existing = await this.dependencies.operations.lookup(
        input.operationKey,
        requestIdentity,
      );
      if (existing.status === "active") {
        await this.poison("reconciliation_required");
        return this.rememberLaunch(
          input.operationKey,
          requestDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "reconciliation_required",
            mutationAttempted: false,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: false,
          }),
        );
      }
      if (existing.status === "complete") {
        const running = (await this.readApps()).filter(
          (app) =>
            app.bundleId === capability.bundleId &&
            app.launchPath === capability.launchPath &&
            app.running,
        );
        if (existing.outcome !== "verified" || running.length !== 1) {
          await this.poison("reconciliation_required");
          return this.rememberLaunch(
            input.operationKey,
            requestDigest,
            Object.freeze({
              outcome: "unknown",
              reasonCode: "reconciliation_required",
              mutationAttempted: true,
              reconciliationRequired: true,
              safeToRetry: false,
              replayed: true,
            }),
          );
        }
        const app = running[0]!;
        this.apps.set(input.appRef, Object.freeze({ ...app }));
        return this.rememberLaunch(
          input.operationKey,
          requestDigest,
          Object.freeze({
            outcome: "verified",
            reasonCode: "idempotent_replay",
            app: this.appSummary(input.appRef, app),
            mutationAttempted: true,
            reconciliationRequired: false,
            safeToRetry: false,
            replayed: true,
          }),
        );
      }

      const reserved = await this.dependencies.operations.reserve(
        input.operationKey,
        requestIdentity,
        this.runId,
      );
      if (reserved.status !== "reserved") {
        await this.poison("reconciliation_required");
        return this.rememberLaunch(
          input.operationKey,
          requestDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "reconciliation_required",
            mutationAttempted: false,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: reserved.status === "complete",
          }),
        );
      }

      let launched: ParsedApp;
      try {
        const raw = await this.dependencies.driver.call("launch_app", {
          bundle_id: capability.bundleId,
        });
        const receipt = parseLaunchReceipt(capability, raw);
        launched = verifyLaunchedIdentity(
          capability,
          receipt,
          await this.readApps(),
        );
      } catch {
        await this.completeOperation(
          input.operationKey,
          reserved.operationId,
          "unknown",
        );
        await this.poison("reconciliation_required");
        return this.rememberLaunch(
          input.operationKey,
          requestDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "ambiguous_dispatch",
            mutationAttempted: true,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: false,
          }),
        );
      }

      await this.completeOperation(
        input.operationKey,
        reserved.operationId,
        "verified",
      );
      this.windows.clear();
      this.clearObservations();
      this.apps.set(input.appRef, Object.freeze({ ...launched }));
      return this.rememberLaunch(
        input.operationKey,
        requestDigest,
        Object.freeze({
          outcome: "verified",
          reasonCode: "app_launched",
          app: this.appSummary(input.appRef, launched),
          mutationAttempted: true,
          reconciliationRequired: false,
          safeToRetry: false,
          replayed: false,
        }),
      );
    });
  }

  async listWindows(
    input: Readonly<{ appRef: string }>,
  ): Promise<readonly NativeWindowSummary[]> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const capability = this.apps.get(input.appRef);
      if (!capability)
        throw new Error("native app capability is stale or invalid");
      const app = await this.assertAppBinding(
        capability.bundleId,
        capability.launchPath,
        capability.pid,
      );
      const windows = await this.readWindows(app.pid);
      for (const [ref, existing] of this.windows) {
        if (existing.appRef === input.appRef) {
          this.invalidateTarget(existing.target);
          this.windows.delete(ref);
        }
      }
      return Object.freeze(
        windows.map((window) => {
          const windowRef = randomOpaqueId("nwin");
          this.windows.set(
            windowRef,
            Object.freeze({
              appRef: input.appRef,
              target: Object.freeze({
                bundleId: app.bundleId,
                launchPath: app.launchPath,
                pid: window.pid,
                windowId: window.windowId,
              }),
            }),
          );
          return Object.freeze({
            appRef: input.appRef,
            windowRef,
            title: safeUiText(window.title),
            onScreen: window.onScreen,
            onCurrentSpace: window.onCurrentSpace,
            minimized: window.minimized,
            untrustedText: true as const,
          });
        }),
      );
    });
  }

  async observe(target: NativeWindowTarget): Promise<NativeObservation> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const capability = this.windows.get(target.windowRef);
      if (!capability)
        throw new Error("native window capability is stale or invalid");
      const capture = await this.captureWindow(capability.target);
      return this.publishObservation(capture, target);
    });
  }

  async observeVisual(
    target: NativeWindowTarget,
  ): Promise<NativeVisualOverview> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const capability = this.windows.get(target.windowRef);
      if (!capability)
        throw new Error("native window capability is stale or invalid");
      const capture = await this.captureVisualWindow(capability.target);
      this.invalidateTarget(capability.target);
      const overviewId = randomOpaqueId("nvobs");
      const grid = createOpaqueVisualGrid(capture.digest, this.identityKey);
      const regions = new Map<string, NormalizedVisualPoint>();
      for (const cell of grid.descriptor.cells)
        regions.set(cell.cellRef, grid.resolveCell(cell.cellRef));
      this.visualOverviews.set(
        overviewId,
        Object.freeze({
          target: capability.target,
          publicTarget: target,
          capture,
          regions,
        }),
      );
      return Object.freeze({
        id: overviewId,
        target,
        width: capture.width,
        height: capture.height,
        image: capture.image,
        regions: Object.freeze(
          grid.descriptor.cells.map((cell) =>
            Object.freeze({ id: cell.cellRef, label: cell.label }),
          ),
        ),
      });
    });
  }

  async refineVisual(
    input: Readonly<{
      overviewId: string;
      regionId: string;
    }>,
  ): Promise<NativeVisualDetail> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const overview = this.visualOverviews.get(input.overviewId);
      const point = overview?.regions.get(input.regionId);
      if (!overview || !point)
        throw new Error(
          "native visual observation capability is stale or invalid",
        );

      const freshRoot = await this.captureVisualWindow(overview.target);
      assertExactVisualFreshness(overview.capture, freshRoot);
      const halfCell = 1 / 16;
      const bounds = Object.freeze({
        x1: Math.max(
          0,
          Math.floor((point.x - halfCell) * overview.capture.width),
        ),
        y1: Math.max(
          0,
          Math.floor((point.y - halfCell) * overview.capture.height),
        ),
        x2: Math.min(
          overview.capture.width,
          Math.ceil((point.x + halfCell) * overview.capture.width),
        ),
        y2: Math.min(
          overview.capture.height,
          Math.ceil((point.y + halfCell) * overview.capture.height),
        ),
      });
      const zoom = await this.captureZoom(overview.target, bounds);
      const grid = createOpaqueVisualGrid(zoom.digest, this.identityKey);

      this.invalidateTarget(overview.target);
      const observationId = randomOpaqueId("nobs");
      const candidateIds: string[] = [];
      const candidates: NativeCandidate[] = [];
      for (const cell of grid.descriptor.cells) {
        const candidateId = randomOpaqueId("ncand");
        const visualPoint = bindNormalizedVisualPoint(
          zoom,
          grid.resolveCell(cell.cellRef),
        );
        const binding: CandidateBinding = Object.freeze({
          observationId,
          target: overview.target,
          publicTarget: overview.publicTarget,
          targetKind: "visual_cell",
          role: "VisualGridCell",
          label: cell.label,
          elementIndex: null,
          identityDigest: this.identityDigest(
            `visual\0${overview.capture.digest}\0${zoom.digest}\0${cell.label}`,
          ),
          menuPath: null,
          visualPoint,
          visualRootCapture: overview.capture,
          visualZoomBounds: bounds,
          visualZoomCapture: zoom,
          actionKinds: Object.freeze<NativeActionKind[]>(["click"]),
          clickActivations: Object.freeze<NativeClickActivation[]>([]),
          riskByAction: Object.freeze({ click: "r3_consequential" }),
        });
        this.candidates.set(candidateId, binding);
        candidateIds.push(candidateId);
        candidates.push(
          Object.freeze({
            id: candidateId,
            targetKind: "visual_cell",
            role: "VisualGridCell",
            label: cell.label,
            valuePresent: false,
            enabled: true,
            selected: null,
            actionKinds: binding.actionKinds,
            riskByAction: binding.riskByAction,
            untrustedText: true,
          }),
        );
      }
      const key = targetKey(overview.target);
      this.observations.set(
        observationId,
        Object.freeze({
          targetKey: key,
          candidateIds: Object.freeze(candidateIds),
        }),
      );
      this.currentObservationByTarget.set(key, observationId);
      return Object.freeze({
        observation: Object.freeze({
          id: observationId,
          target: overview.publicTarget,
          complete: true,
          actionable: true,
          candidateCount: candidates.length,
          candidates: Object.freeze(candidates),
          untrustedUiData: true,
        }),
        width: zoom.width,
        height: zoom.height,
        image: zoom.image,
      });
    });
  }

  async execute(
    input: Readonly<{
      operationKey: string;
      observationId: string;
      candidateId: string;
      action: NativeAction;
      verification: NativeVerification;
      authorizeConsequentialAction?: NativeApprovalGate;
    }>,
  ): Promise<NativeExecutionResult> {
    return this.mutex.runExclusive(async () => {
      await this.ensureStarted();
      const callDigest = createHmac("sha256", this.identityKey)
        .update("jev-cua:native-execute-call:v1\0", "utf8")
        .update(
          JSON.stringify({
            observationId: input.observationId,
            candidateId: input.candidateId,
            action: input.action,
            verification: input.verification,
          }),
          "utf8",
        )
        .digest("hex");
      const prior = this.executionTombstones.get(input.operationKey);
      if (prior) {
        if (prior.requestDigest !== callDigest)
          throw new Error("native operation key was used for another request");
        return prior.result;
      }
      if (this.poisoned) return this.reconciliationResult();
      validateAction(input.action);
      assertVerification(input.verification);
      const binding = this.resolveCandidate(
        input.observationId,
        input.candidateId,
      );
      if (!binding.actionKinds.includes(input.action.kind))
        throw new Error("native action is not available for this candidate");

      let exactExpectedValue: string | undefined;
      if (input.action.kind === "set_value") {
        exactExpectedValue = input.action.value;
      } else if (input.action.kind === "type_text") {
        const predicate = input.verification.expect[0];
        const element =
          input.verification.expect.length === 1 &&
          predicate &&
          "element" in predicate
            ? predicate.element
            : undefined;
        const selector = element?.selector;
        const matchesBoundControl =
          element !== undefined &&
          typeof element.valueEquals === "string" &&
          (selector?.role === undefined || selector.role === binding.role) &&
          (selector?.labelContains === undefined ||
            (binding.label !== null &&
              binding.label.includes(selector.labelContains)));
        if (!matchesBoundControl) {
          return Object.freeze({
            outcome: "denied",
            reasonCode: "verification_mismatch",
            mutationAttempted: false,
            reconciliationRequired: false,
            safeToRetry: false,
            replayed: false,
          });
        }
        exactExpectedValue = element.valueEquals;
      }

      const risk = actionRisk(input.action, binding);
      if (risk === "r4_forbidden") {
        return Object.freeze({
          outcome: "denied",
          reasonCode: "forbidden_action",
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: false,
          replayed: false,
        });
      }
      const verificationArgs = verificationArguments(
        binding.target,
        this.session,
        input.verification,
      );
      const requestIdentity = JSON.stringify({
        schema: "jev-cua.native-operation-request.v1",
        runId: this.runId,
        target: binding.target,
        candidateIdentity: binding.identityDigest,
        elementIndex: binding.elementIndex,
        action: input.action,
        verification: verificationArgs,
      });
      const existing = await this.dependencies.operations.lookup(
        input.operationKey,
        requestIdentity,
      );
      if (existing.status === "active") {
        await this.poison("reconciliation_required");
        return this.reconciliationResult();
      }
      if (existing.status === "complete") return replayResult(existing.outcome);

      let precondition: Record<string, unknown>;
      try {
        precondition = await this.dependencies.driver.call("verify_state", {
          ...verificationArgs,
          timeout_ms: 0,
          stable_samples: 1,
        });
      } catch {
        return Object.freeze({
          outcome: "unknown",
          reasonCode: "precondition_unknown",
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: true,
          replayed: false,
        });
      }
      const preconditionStatus = this.verificationStatus(
        precondition,
        input.verification.expect.length,
        1,
      );
      if (preconditionStatus === "verified") {
        return Object.freeze({
          outcome: "denied",
          reasonCode: "precondition_already_satisfied",
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: false,
          replayed: false,
        });
      }
      if (preconditionStatus !== "refuted") {
        return Object.freeze({
          outcome: "unknown",
          reasonCode: "precondition_unknown",
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: true,
          replayed: false,
        });
      }

      let approvalConsumed = false;
      if (!riskMayExecuteAutomatically(risk)) {
        const gate = input.authorizeConsequentialAction;
        let decision: NativeApprovalDecision = Object.freeze({
          status: "unsupported",
        });
        if (gate) {
          try {
            decision = await gate(
              Object.freeze({
                runId: this.runId,
                operationKey: input.operationKey,
                target: binding.publicTarget,
                actionKind: input.action.kind,
                risk,
              }),
            );
          } catch {
            decision = Object.freeze({ status: "failed" });
          }
        }
        if (decision.status !== "approved") {
          const reasonCode =
            decision.status === "declined"
              ? "approval_declined"
              : decision.status === "cancelled"
                ? "approval_cancelled"
                : decision.status === "failed"
                  ? "approval_failed"
                  : "approval_channel_unavailable";
          return this.rememberExecution(
            input.operationKey,
            callDigest,
            Object.freeze({
              outcome:
                decision.status === "declined" ? "denied" : "approval_required",
              reasonCode,
              mutationAttempted: false,
              reconciliationRequired: false,
              safeToRetry: false,
              replayed: false,
            }),
          );
        }
        approvalConsumed = true;
      }

      if (approvalConsumed) {
        let currentPrecondition: Record<string, unknown>;
        try {
          currentPrecondition = await this.dependencies.driver.call(
            "verify_state",
            {
              ...verificationArgs,
              timeout_ms: 0,
              stable_samples: 1,
            },
          );
        } catch {
          return this.rememberExecution(
            input.operationKey,
            callDigest,
            Object.freeze({
              outcome: "unknown",
              reasonCode: "precondition_unknown",
              mutationAttempted: false,
              reconciliationRequired: false,
              safeToRetry: false,
              replayed: false,
            }),
          );
        }
        const currentStatus = this.verificationStatus(
          currentPrecondition,
          input.verification.expect.length,
          1,
        );
        if (currentStatus === "verified") {
          return this.rememberExecution(
            input.operationKey,
            callDigest,
            Object.freeze({
              outcome: "denied",
              reasonCode: "precondition_already_satisfied",
              mutationAttempted: false,
              reconciliationRequired: false,
              safeToRetry: false,
              replayed: false,
            }),
          );
        }
        if (currentStatus !== "refuted") {
          return this.rememberExecution(
            input.operationKey,
            callDigest,
            Object.freeze({
              outcome: "unknown",
              reasonCode: "precondition_unknown",
              mutationAttempted: false,
              reconciliationRequired: false,
              safeToRetry: false,
              replayed: false,
            }),
          );
        }
      }

      let rebound: ParsedElement | VisualRebind | null | undefined;
      try {
        if (binding.targetKind === "visual_cell") {
          rebound = await this.rebindVisual(binding);
        } else {
          const fresh = await this.captureWindow(binding.target);
          rebound = this.rebind(binding, fresh, input.action);
        }
      } catch {
        const result = Object.freeze({
          outcome: "unknown" as const,
          reasonCode: "stale_observation" as const,
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: !approvalConsumed,
          replayed: false,
        });
        return approvalConsumed
          ? this.rememberExecution(input.operationKey, callDigest, result)
          : result;
      }
      if (rebound === undefined) {
        const result = Object.freeze({
          outcome: "unknown" as const,
          reasonCode: "stale_observation" as const,
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: !approvalConsumed,
          replayed: false,
        });
        return approvalConsumed
          ? this.rememberExecution(input.operationKey, callDigest, result)
          : result;
      }
      if (
        input.action.kind === "set_value" &&
        rebound !== null &&
        !("kind" in rebound) &&
        rebound.value === input.action.value
      ) {
        const result = Object.freeze({
          outcome: "denied",
          reasonCode: "precondition_already_satisfied",
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: false,
          replayed: false,
        });
        return approvalConsumed
          ? this.rememberExecution(input.operationKey, callDigest, result)
          : result;
      }

      const actionArgs = this.actionArguments(binding, rebound, input.action);
      const reserved = await this.dependencies.operations.reserve(
        input.operationKey,
        requestIdentity,
        this.runId,
      );
      if (reserved.status === "active") {
        await this.poison("reconciliation_required");
        return this.rememberExecution(
          input.operationKey,
          callDigest,
          this.reconciliationResult(),
        );
      }
      if (reserved.status === "complete")
        return this.rememberExecution(
          input.operationKey,
          callDigest,
          replayResult(reserved.outcome),
        );

      this.invalidateTarget(binding.target);
      let receipt: NativeReceipt;
      try {
        const raw = await this.dependencies.driver.call(
          input.action.kind,
          actionArgs,
        );
        receipt = parseNativeReceipt(
          input.action,
          raw,
          binding.targetKind === "visual_cell",
        );
      } catch {
        if (binding.targetKind === "visual_cell")
          await this.captureVisualWindow(binding.target).catch(() => undefined);
        else await this.captureWindow(binding.target).catch(() => undefined);
        await this.poison("reconciliation_required");
        return this.rememberExecution(
          input.operationKey,
          callDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "ambiguous_dispatch",
            mutationAttempted: true,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: false,
          }),
        );
      }

      let postActionCapture: CapturedWindow | undefined;
      try {
        if (binding.targetKind !== "visual_cell") {
          postActionCapture = await this.captureWindow(binding.target);
          if (!postActionCapture.actionable)
            throw new Error("native post-action observation is not actionable");
        }
      } catch {
        await this.completeOperation(
          input.operationKey,
          reserved.operationId,
          "unknown",
        );
        await this.poison("reconciliation_required");
        return this.rememberExecution(
          input.operationKey,
          callDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "post_action_observation_failed",
            mutationAttempted: true,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: false,
            effect: receipt.effect,
            route: receipt.route,
          }),
        );
      }

      if (exactExpectedValue !== undefined) {
        if (!postActionCapture)
          throw new Error("native value verification capture is unavailable");
        const requiredSamples = input.verification.stableSamples ?? 2;
        let exactStatus: "verified" | "refuted" | "unknown" = "verified";
        let exactCapture = postActionCapture;
        for (let sample = 0; sample < requiredSamples; sample += 1) {
          if (sample > 0) {
            try {
              exactCapture = await this.captureWindow(binding.target);
            } catch {
              exactStatus = "unknown";
              break;
            }
          }
          const exactPostActionElement = this.rebind(
            binding,
            exactCapture,
            input.action,
          );
          if (
            exactPostActionElement === undefined ||
            exactPostActionElement === null
          ) {
            exactStatus = "unknown";
            break;
          }
          if (exactPostActionElement.value !== exactExpectedValue) {
            exactStatus = "refuted";
            break;
          }
        }
        if (exactStatus !== "verified") {
          await this.completeOperation(
            input.operationKey,
            reserved.operationId,
            exactStatus,
          );
          await this.poison("reconciliation_required");
          return this.rememberExecution(
            input.operationKey,
            callDigest,
            Object.freeze({
              outcome: exactStatus,
              reasonCode:
                exactStatus === "refuted"
                  ? "verification_unsatisfied"
                  : "verification_unknown",
              mutationAttempted: true,
              reconciliationRequired: true,
              safeToRetry: false,
              replayed: false,
              effect: receipt.effect,
              route: receipt.route,
            }),
          );
        }
      }

      let verification: Record<string, unknown>;
      try {
        verification = await this.dependencies.driver.call(
          "verify_state",
          verificationArgs,
        );
      } catch {
        await this.completeOperation(
          input.operationKey,
          reserved.operationId,
          "unknown",
        );
        await this.poison("reconciliation_required");
        return this.rememberExecution(
          input.operationKey,
          callDigest,
          Object.freeze({
            outcome: "unknown",
            reasonCode: "verification_unknown",
            mutationAttempted: true,
            reconciliationRequired: true,
            safeToRetry: false,
            replayed: false,
            effect: receipt.effect,
            route: receipt.route,
          }),
        );
      }
      const status = this.verificationStatus(
        verification,
        input.verification.expect.length,
        input.verification.stableSamples ?? 2,
      );
      await this.completeOperation(
        input.operationKey,
        reserved.operationId,
        status,
      );
      if (status !== "verified") await this.poison("reconciliation_required");
      return this.rememberExecution(
        input.operationKey,
        callDigest,
        Object.freeze({
          outcome: status,
          reasonCode:
            status === "verified"
              ? "verified"
              : status === "refuted"
                ? "verification_unsatisfied"
                : "verification_unknown",
          mutationAttempted: true,
          reconciliationRequired: status !== "verified",
          safeToRetry: false,
          replayed: false,
          effect: receipt.effect,
          route: receipt.route,
        }),
      );
    });
  }

  async end(): Promise<NativeEndResult> {
    return this.mutex.runExclusive(async () => {
      if (this.ended) {
        const leaseReleased = await this.releasePendingLease();
        const cleanupSucceeded =
          this.endBaseCleanupSucceeded === true && leaseReleased;
        return Object.freeze({
          cleanupSucceeded,
          reconciliationRequired: this.poisoned || !cleanupSucceeded,
        });
      }
      this.ended = true;
      if (!this.started) {
        this.endBaseCleanupSucceeded = !this.barrierMarked;
        const leaseReleased = await this.releasePendingLease();
        const cleanupSucceeded = this.endBaseCleanupSucceeded && leaseReleased;
        this.identityKey.fill(0);
        return Object.freeze({
          cleanupSucceeded,
          reconciliationRequired:
            this.poisoned || this.barrierMarked || !cleanupSucceeded,
        });
      }
      let cleanupSucceeded = false;
      try {
        const receipt = await this.dependencies.driver.call("end_session", {
          session: this.session,
        });
        cleanupSucceeded =
          receipt.active === false && receipt.session === this.session;
      } catch {
        cleanupSucceeded = false;
      }
      if (!cleanupSucceeded) await this.poison("cleanup_unconfirmed");
      if (cleanupSucceeded && !this.poisoned && this.barrierMarked) {
        try {
          await this.dependencies.executionBarrier.clear(
            this.runId,
            this.session,
          );
          this.barrierMarked = false;
        } catch {
          cleanupSucceeded = false;
          this.poisoned = true;
        }
      }
      this.endBaseCleanupSucceeded = cleanupSucceeded;
      const leaseReleased = await this.releasePendingLease();
      cleanupSucceeded = cleanupSucceeded && leaseReleased;
      this.apps.clear();
      this.windows.clear();
      this.candidates.clear();
      this.observations.clear();
      this.currentObservationByTarget.clear();
      this.visualOverviews.clear();
      this.executionTombstones.clear();
      this.launchTombstones.clear();
      this.identityKey.fill(0);
      return Object.freeze({
        cleanupSucceeded,
        reconciliationRequired: this.poisoned || !cleanupSucceeded,
      });
    });
  }

  async quarantine(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.ended) return;
      await this.poison("reconciliation_required");
      this.clearObservations();
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.ended) throw new Error("native computer-use run has ended");
    if (this.started) return;
    this.releaseLease = await this.dependencies.lease.acquire(this.runId);
    let sessionAttempted = false;
    try {
      await this.dependencies.executionBarrier.assertClear();
      await this.dependencies.safetyRuns.assertSafeForLiveExecution();
      await this.dependencies.operations.assertSafeForExecution();
      await this.dependencies.executionBarrier.markActive(
        this.runId,
        this.session,
      );
      this.barrierMarked = true;
      await this.dependencies.driver.connect();
      const tools = await this.dependencies.driver.listTools();
      const available = new Set(tools.map((tool) => tool.name));
      for (const required of REQUIRED_TOOLS) {
        if (!available.has(required))
          throw new Error(
            `required native Cua tool is unavailable: ${required}`,
          );
      }
      sessionAttempted = true;
      const receipt = await this.dependencies.driver.call("start_session", {
        session: this.session,
      });
      if (receipt.active !== true || receipt.session !== this.session)
        throw new Error("Cua returned no positive native session receipt");
      this.started = true;
    } catch (error: unknown) {
      let sessionClean = !sessionAttempted;
      if (sessionAttempted) {
        try {
          const ended = await this.dependencies.driver.call("end_session", {
            session: this.session,
          });
          sessionClean =
            ended.active === false && ended.session === this.session;
        } catch {
          sessionClean = false;
        }
      }
      if (this.barrierMarked) {
        if (sessionClean) {
          try {
            await this.dependencies.executionBarrier.clear(
              this.runId,
              this.session,
            );
            this.barrierMarked = false;
          } catch {
            this.poisoned = true;
            await this.dependencies.executionBarrier
              .retain(this.runId, this.session, "cleanup_unconfirmed")
              .catch(() => undefined);
          }
        } else {
          await this.dependencies.executionBarrier
            .retain(this.runId, this.session, "cleanup_unconfirmed")
            .catch(() => undefined);
          this.poisoned = true;
        }
      }
      // Keep a failed release callback so manager startup cleanup can retry it
      // through end(). A still-held live lock makes that end fail closed even
      // without conflating a transient lease error with mutation uncertainty.
      await this.releasePendingLease();
      throw error;
    }
  }

  private async readApps(): Promise<readonly ParsedApp[]> {
    return parseApps(await this.dependencies.driver.call("list_apps", {}));
  }

  private appSummary(appRef: string, app: ParsedApp): NativeAppSummary {
    return Object.freeze({
      appRef,
      bundleId: app.bundleId,
      name: safeUiText(app.name),
      running: app.running,
      active: app.active,
      launchable: !app.running && app.launchPath !== null,
      untrustedText: true,
    });
  }

  private async assertAppBinding(
    bundleId: string,
    launchPath: string | null,
    pid: number,
  ): Promise<ParsedApp> {
    if (!bundleId.trim() || bundleId.length > 512 || !validPositiveInteger(pid))
      throw new Error("native app binding is invalid");
    const matches = (await this.readApps()).filter(
      (app) =>
        app.bundleId === bundleId &&
        app.launchPath === launchPath &&
        app.running &&
        app.pid === pid,
    );
    if (matches.length !== 1) throw new Error("native app binding is stale");
    return matches[0]!;
  }

  private async readWindows(pid: number): Promise<readonly ParsedWindow[]> {
    return parseWindows(
      await this.dependencies.driver.call("list_windows", { pid }),
    );
  }

  private async captureWindow(
    target: ExactWindowTarget,
  ): Promise<CapturedWindow> {
    assertTarget(target);
    const app = await this.assertAppBinding(
      target.bundleId,
      target.launchPath,
      target.pid,
    );
    const windows = await this.readWindows(target.pid);
    if (
      windows.filter(
        (window) =>
          window.pid === target.pid && window.windowId === target.windowId,
      ).length !== 1
    ) {
      throw new Error("native window binding is stale");
    }
    const output = await this.dependencies.driver.call("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      session: this.session,
      include_screenshot: false,
      include_accessibility_tree: true,
      max_elements: 2_000,
      max_depth: 25,
    });
    if (output.pid !== target.pid || output.window_id !== target.windowId)
      throw new Error("native observation crossed its exact window binding");
    const elements = parseElements(output);
    const actionable = captureIsActionable(output, target, elements);
    return Object.freeze({
      target,
      appName: app.name,
      complete: output.elements_complete === true && actionable,
      actionable,
      elements,
    });
  }

  private async captureVisualWindow(
    target: ExactWindowTarget,
  ): Promise<NativeVisualCapture> {
    assertTarget(target);
    await this.assertAppBinding(target.bundleId, target.launchPath, target.pid);
    const windows = await this.readWindows(target.pid);
    if (
      windows.filter(
        (window) =>
          window.pid === target.pid && window.windowId === target.windowId,
      ).length !== 1
    ) {
      throw new Error("native visual window binding is stale");
    }
    const callWithContent = this.dependencies.driver.callWithContent;
    if (!callWithContent)
      throw new Error("native visual capture is unavailable");
    const result = await callWithContent.call(
      this.dependencies.driver,
      "get_window_state",
      {
        pid: target.pid,
        window_id: target.windowId,
        session: this.session,
        include_screenshot: true,
        include_accessibility_tree: false,
        max_dimension: 1_600,
      },
    );
    if (result.images.length !== 1)
      throw new Error("native visual capture returned an ambiguous image set");
    const capture = validateCuaWindowScreenshot(
      result.structuredContent,
      result.images[0],
    );
    if (capture.pid !== target.pid || capture.windowId !== target.windowId)
      throw new Error("native visual capture crossed its exact window binding");
    return capture;
  }

  private async captureZoom(
    target: ExactWindowTarget,
    bounds: Readonly<{ x1: number; y1: number; x2: number; y2: number }>,
  ): Promise<NativeVisualZoomCapture> {
    const callWithContent = this.dependencies.driver.callWithContent;
    if (!callWithContent) throw new Error("native visual zoom is unavailable");
    const result = await callWithContent.call(
      this.dependencies.driver,
      "zoom",
      {
        pid: target.pid,
        window_id: target.windowId,
        x1: bounds.x1,
        y1: bounds.y1,
        x2: bounds.x2,
        y2: bounds.y2,
      },
    );
    if (result.images.length !== 1)
      throw new Error("native visual zoom returned an ambiguous image set");
    return validateCuaZoomScreenshot(
      result.structuredContent,
      result.images[0],
    );
  }

  private publishObservation(
    capture: CapturedWindow,
    publicTarget: NativeWindowTarget,
  ): NativeObservation {
    this.invalidateTarget(capture.target);
    const observationId = randomOpaqueId("nobs");
    const candidates: NativeCandidate[] = [];
    const candidateIds: string[] = [];
    if (capture.actionable) {
      const windowId = randomOpaqueId("ncand");
      const windowBinding: CandidateBinding = Object.freeze({
        observationId,
        target: capture.target,
        publicTarget,
        targetKind: "window",
        role: "AXWindow",
        label: null,
        elementIndex: null,
        identityDigest: this.identityDigest("window"),
        menuPath: null,
        visualPoint: null,
        visualRootCapture: null,
        visualZoomBounds: null,
        visualZoomCapture: null,
        actionKinds: Object.freeze<NativeActionKind[]>(["press_key", "scroll"]),
        clickActivations: Object.freeze<NativeClickActivation[]>([]),
        riskByAction: Object.freeze({
          press_key: "r1_reversible",
          scroll: "r1_reversible",
        }),
      });
      this.candidates.set(windowId, windowBinding);
      candidateIds.push(windowId);
      candidates.push(
        Object.freeze({
          id: windowId,
          targetKind: "window",
          role: "AXWindow",
          valuePresent: false,
          actionKinds: windowBinding.actionKinds,
          riskByAction: windowBinding.riskByAction,
          untrustedText: true,
        }),
      );

      const identities = this.elementIdentities(capture.elements);
      const pathsByElement = menuPaths(capture.elements, capture.appName);
      const counts = new Map<string, number>();
      for (const digest of identities.values())
        counts.set(digest, (counts.get(digest) ?? 0) + 1);
      for (const element of capture.elements) {
        const digest = identities.get(element.index);
        if (!digest || counts.get(digest) !== 1 || element.enabled === false)
          continue;
        const menuPath = pathsByElement.get(element.index);
        const kinds = actionKindsForElement(element, menuPath);
        const risks = riskByActionForElement(capture.target, element, menuPath);
        if (kinds.length === 0) continue;
        const id = randomOpaqueId("ncand");
        const binding: CandidateBinding = Object.freeze({
          observationId,
          target: capture.target,
          publicTarget,
          targetKind: "element",
          role: element.role,
          label: element.label,
          elementIndex: element.index,
          identityDigest: digest,
          menuPath: menuPath ?? null,
          visualPoint: null,
          visualRootCapture: null,
          visualZoomBounds: null,
          visualZoomCapture: null,
          actionKinds: kinds,
          clickActivations: clickActivations(element),
          riskByAction: risks,
        });
        this.candidates.set(id, binding);
        candidateIds.push(id);
        candidates.push(
          Object.freeze({
            id,
            targetKind: "element",
            role: safeUiText(element.role),
            ...(menuPath
              ? { label: safeUiText(menuPath.join(" > ")) }
              : element.label
                ? { label: safeUiText(element.label) }
                : {}),
            valuePresent: element.value !== null && element.value.length > 0,
            enabled: element.enabled,
            selected: element.selected,
            actionKinds: kinds,
            riskByAction: risks,
            untrustedText: true,
          }),
        );
      }
    }
    const key = targetKey(capture.target);
    this.observations.set(
      observationId,
      Object.freeze({
        targetKey: key,
        candidateIds: Object.freeze(candidateIds),
      }),
    );
    this.currentObservationByTarget.set(key, observationId);
    return Object.freeze({
      id: observationId,
      target: publicTarget,
      complete: capture.complete,
      actionable: capture.actionable,
      candidateCount: candidates.length,
      candidates: Object.freeze(candidates),
      untrustedUiData: true,
    });
  }

  private resolveCandidate(
    observationId: string,
    candidateId: string,
  ): CandidateBinding {
    const observation = this.observations.get(observationId);
    const binding = this.candidates.get(candidateId);
    if (
      !observation ||
      !binding ||
      binding.observationId !== observationId ||
      !observation.candidateIds.includes(candidateId) ||
      this.currentObservationByTarget.get(observation.targetKey) !==
        observationId
    ) {
      throw new Error("native observation capability is stale or invalid");
    }
    return binding;
  }

  private elementIdentities(
    elements: readonly ParsedElement[],
  ): Map<number, string> {
    const byIndex = new Map(
      elements.map((element) => [element.index, element]),
    );
    const material = new Map<number, string>();
    const visit = (
      element: ParsedElement,
      seen: ReadonlySet<number>,
    ): string => {
      const cached = material.get(element.index);
      if (cached) return cached;
      if (seen.has(element.index)) return "cycle";
      const nextSeen = new Set(seen).add(element.index);
      const parent =
        element.parentIndex === null
          ? undefined
          : byIndex.get(element.parentIndex);
      const parentMaterial = parent ? visit(parent, nextSeen) : "root";
      const value = JSON.stringify([
        parentMaterial,
        element.role,
        element.label ?? "",
      ]);
      material.set(element.index, value);
      return value;
    };
    return new Map(
      elements.map((element) => [
        element.index,
        this.identityDigest(visit(element, new Set())),
      ]),
    );
  }

  private identityDigest(value: string): string {
    return createHmac("sha256", this.identityKey)
      .update("jev-cua:native-element:v1\0", "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  private rebind(
    binding: CandidateBinding,
    fresh: CapturedWindow,
    action: NativeAction,
  ): ParsedElement | null | undefined {
    if (
      !fresh.actionable ||
      targetKey(fresh.target) !== targetKey(binding.target)
    )
      return undefined;
    if (binding.targetKind === "window") return null;
    const identities = this.elementIdentities(fresh.elements);
    if (
      fresh.elements.filter(
        (element) => identities.get(element.index) === binding.identityDigest,
      ).length !== 1
    ) {
      return undefined;
    }
    const matches = fresh.elements.filter(
      (element) =>
        element.index === binding.elementIndex &&
        identities.get(element.index) === binding.identityDigest,
    );
    if (matches.length !== 1) return undefined;
    const element = matches[0]!;
    const freshMenuPath = menuPaths(fresh.elements, fresh.appName).get(
      element.index,
    );
    if (
      element.enabled === false ||
      !actionKindsForElement(element, freshMenuPath).includes(action.kind)
    )
      return undefined;
    if (action.kind === "click") {
      const activation = action.activation ?? "press";
      if (
        !binding.clickActivations.includes(activation) ||
        !clickActivations(element).includes(activation)
      )
        return undefined;
    }
    if (
      action.kind === "invoke_menu" &&
      (binding.menuPath === null ||
        freshMenuPath === undefined ||
        JSON.stringify(freshMenuPath) !== JSON.stringify(binding.menuPath))
    ) {
      return undefined;
    }
    return element;
  }

  private async rebindVisual(
    binding: CandidateBinding,
  ): Promise<VisualRebind | undefined> {
    if (
      binding.targetKind !== "visual_cell" ||
      binding.visualPoint === null ||
      binding.visualRootCapture === null ||
      binding.visualZoomBounds === null ||
      binding.visualZoomCapture === null
    ) {
      return undefined;
    }
    const root = await this.captureVisualWindow(binding.target);
    assertExactVisualFreshness(binding.visualRootCapture, root);
    const zoom = await this.captureZoom(
      binding.target,
      binding.visualZoomBounds,
    );
    if (
      zoom.mimeType !== binding.visualZoomCapture.mimeType ||
      zoom.width !== binding.visualZoomCapture.width ||
      zoom.height !== binding.visualZoomCapture.height ||
      zoom.digest !== binding.visualZoomCapture.digest ||
      binding.visualPoint.captureDigest !== zoom.digest
    ) {
      return undefined;
    }
    return Object.freeze({ kind: "visual", point: binding.visualPoint });
  }

  private actionArguments(
    binding: CandidateBinding,
    rebound: ParsedElement | VisualRebind | null,
    action: NativeAction,
  ): Record<string, JsonValue> {
    const target = binding.target;
    const base: Record<string, JsonValue> = {
      pid: target.pid,
      window_id: target.windowId,
      session: this.session,
    };
    const element =
      rebound !== null && !("kind" in rebound) ? rebound : undefined;
    const visual = rebound !== null && "kind" in rebound ? rebound : undefined;
    const elementBase: Record<string, JsonValue> = element
      ? { ...base, element_token: element.token }
      : base;
    switch (action.kind) {
      case "click":
        if (visual) {
          return {
            ...base,
            x: visual.point.xPx,
            y: visual.point.yPx,
            from_zoom: true,
            delivery_mode: "background",
          };
        }
        if (!element)
          throw new Error("native click requires an element capability");
        return {
          ...elementBase,
          action: action.activation ?? "press",
          delivery_mode: "background",
        };
      case "type_text":
        if (!element)
          throw new Error("native text entry requires an element capability");
        return {
          ...elementBase,
          text: action.text,
          delivery_mode: "background",
        };
      case "set_value":
        if (!element)
          throw new Error("native value entry requires an element capability");
        return { ...elementBase, value: action.value };
      case "press_key":
        if (visual)
          throw new Error("native visual capabilities cannot press keys");
        return {
          ...elementBase,
          key: action.key.toLowerCase(),
          ...(action.modifiers ? { modifiers: [...action.modifiers] } : {}),
          delivery_mode: "background",
        };
      case "scroll":
        if (visual) throw new Error("native visual capabilities cannot scroll");
        return {
          ...base,
          direction: action.direction,
          by: action.by ?? "line",
          amount: action.amount ?? 3,
          delivery_mode: "background",
        };
      case "invoke_menu":
        if (!element || binding.menuPath === null)
          throw new Error("native menu invocation requires a menu capability");
        return { ...base, path: [...binding.menuPath] };
    }
  }

  private verificationStatus(
    output: Record<string, unknown>,
    expectedPredicateCount: number,
    requiredStableSamples: number,
  ): "verified" | "refuted" | "unknown" {
    if (
      !Number.isSafeInteger(output.samples) ||
      Number(output.samples) < 1 ||
      !Array.isArray(output.predicates) ||
      output.predicates.length !== expectedPredicateCount
    )
      return "unknown";
    const statuses: unknown[] = [];
    for (const [index, predicate] of output.predicates.entries()) {
      if (
        !predicate ||
        typeof predicate !== "object" ||
        Array.isArray(predicate)
      )
        return "unknown";
      const record = predicate as Record<string, unknown>;
      if (
        record.index !== index ||
        !["satisfied", "unsatisfied", "unknown"].includes(
          String(record.status),
        ) ||
        (record.observed_json !== null &&
          typeof record.observed_json !== "string") ||
        (record.status === "unknown"
          ? ![
              "invalid_predicate",
              "unsupported_predicate",
              "untrusted_source",
              "multi_match",
              "target_missing",
              "observation_unavailable",
              "stability_unproven",
            ].includes(String(record.unknown_reason))
          : record.unknown_reason !== null)
      ) {
        return "unknown";
      }
      statuses.push(record.status);
    }
    if (
      output.status === "satisfied" &&
      output.stable === true &&
      Number(output.samples) >= requiredStableSamples &&
      statuses.every((status) => status === "satisfied")
    )
      return "verified";
    if (output.status === "unsatisfied" || statuses.includes("unsatisfied"))
      return "refuted";
    return "unknown";
  }

  private invalidateTarget(target: ExactWindowTarget): void {
    const key = targetKey(target);
    for (const [overviewId, overview] of this.visualOverviews) {
      if (targetKey(overview.target) === key)
        this.visualOverviews.delete(overviewId);
    }
    const observationId = this.currentObservationByTarget.get(key);
    if (!observationId) return;
    const observation = this.observations.get(observationId);
    for (const candidateId of observation?.candidateIds ?? [])
      this.candidates.delete(candidateId);
    this.observations.delete(observationId);
    this.currentObservationByTarget.delete(key);
  }

  private clearObservations(): void {
    this.candidates.clear();
    this.observations.clear();
    this.currentObservationByTarget.clear();
    this.visualOverviews.clear();
  }

  private async completeOperation(
    operationKey: string,
    operationId: string,
    outcome: NativeExecutionOutcome,
  ): Promise<void> {
    try {
      await this.dependencies.operations.complete(
        operationKey,
        operationId,
        outcome,
      );
    } catch {
      await this.poison("reconciliation_required");
      throw new Error("native operation completion could not be made durable");
    }
  }

  private async releasePendingLease(): Promise<boolean> {
    const release = this.releaseLease;
    if (!release) return true;
    try {
      await release();
      this.releaseLease = undefined;
      return true;
    } catch {
      return false;
    }
  }

  private async poison(
    state: "cleanup_unconfirmed" | "reconciliation_required",
  ): Promise<void> {
    this.poisoned = true;
    if (this.barrierMarked) {
      await this.dependencies.executionBarrier
        .retain(this.runId, this.session, state)
        .catch(() => undefined);
    }
  }

  private reconciliationResult(): NativeExecutionResult {
    return Object.freeze({
      outcome: "unknown",
      reasonCode: "reconciliation_required",
      mutationAttempted: false,
      reconciliationRequired: true,
      safeToRetry: false,
      replayed: false,
    });
  }

  private rememberExecution(
    operationKey: string,
    requestDigest: string,
    result: NativeExecutionResult,
  ): NativeExecutionResult {
    const frozen = Object.freeze({ ...result });
    this.executionTombstones.set(
      operationKey,
      Object.freeze({ requestDigest, result: frozen }),
    );
    return frozen;
  }

  private rememberLaunch(
    operationKey: string,
    requestDigest: string,
    result: NativeLaunchResult,
  ): NativeLaunchResult {
    const frozen = Object.freeze({ ...result });
    this.launchTombstones.set(
      operationKey,
      Object.freeze({ requestDigest, result: frozen }),
    );
    return frozen;
  }
}

export type {
  NativeAction,
  NativeAppSummary,
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
