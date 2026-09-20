import type {
  BrowserObservation,
  BrowserRef,
  BrowserTarget,
  DriverClient,
  JsonValue,
  SuccessCondition,
  ValueSlot,
} from "../types.js";
import { asRecord, canonicalJson, sha256 } from "../util.js";

export type BoundBrowser = Readonly<{
  targetId: string;
  tabId: string;
  privateState: boolean;
}>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}

function parseRef(value: unknown): BrowserRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const ref = optionalString(raw.ref);
  if (!ref) return undefined;
  const actions = asArray(raw.actions).filter(
    (action): action is string => typeof action === "string",
  );
  const states =
    raw.states && typeof raw.states === "object" && !Array.isArray(raw.states)
      ? (raw.states as Record<string, unknown>)
      : {};
  const frame = optionalString(raw.frame) ?? "unknown";
  const visibility = optionalString(raw.visibility) ?? "unknown";
  return Object.freeze({
    ref,
    role: optionalString(raw.role) ?? "control",
    name: optionalString(raw.name) ?? optionalString(raw.label) ?? "",
    ...(typeof raw.value === "string" ? { value: raw.value } : {}),
    actions: Object.freeze(actions),
    disabled:
      raw.disabled === true ||
      raw.enabled === false ||
      states.disabled === true,
    frame,
    visibility,
  });
}

export function parseBrowserObservation(
  payload: Record<string, unknown>,
  targetId: string,
  tabId: string,
): BrowserObservation {
  if (payload.status !== "ok" || payload.mode !== "snapshot") {
    throw new Error("Cua returned a non-snapshot browser observation");
  }
  if (payload.target_id !== targetId || payload.tab_id !== tabId) {
    throw new Error(
      "Cua returned a browser observation for a different target",
    );
  }
  const snapshot = requiredRecord(
    payload.snapshot,
    "Cua semantic snapshot metadata is missing",
  );
  if (
    snapshot.format !== "semantic_v2" ||
    typeof snapshot.complete !== "boolean"
  ) {
    throw new Error("Cua returned an unsupported semantic snapshot contract");
  }
  const snapshotId = optionalString(snapshot.id);
  if (!snapshotId) throw new Error("Cua semantic snapshot has no snapshot ID");
  const continuationToken = optionalString(snapshot.continuation);
  if (snapshot.complete && continuationToken) {
    throw new Error(
      "Cua semantic snapshot is complete but also advertises a continuation",
    );
  }
  if (!Array.isArray(payload.refs))
    throw new Error("Cua semantic action refs are missing");
  const refs = asArray(payload.refs)
    .map(parseRef)
    .filter((ref): ref is BrowserRef => ref !== undefined);
  const uniqueRefs = new Set(refs.map((ref) => ref.ref));
  if (uniqueRefs.size !== refs.length)
    throw new Error("Cua semantic snapshot contains duplicate refs");
  const page = requiredRecord(
    payload.page,
    "Cua semantic page metadata is missing",
  );
  const url = optionalString(page.url);
  if (!url) throw new Error("Cua semantic snapshot has no page URL");
  safeOrigin(url);
  const title = optionalString(page.title);
  const outline = optionalString(payload.outline);
  const digestPayload = {
    url,
    title: title ?? null,
    outline: outline ?? null,
    complete: snapshot.complete,
    refs: refs.map((ref) => ({
      role: ref.role,
      name: ref.name,
      value: ref.value ?? null,
      actions: [...ref.actions],
      disabled: ref.disabled,
      frame: ref.frame,
      visibility: ref.visibility,
    })),
  };
  return Object.freeze({
    targetId,
    tabId,
    snapshotId,
    url,
    ...(title ? { title } : {}),
    ...(outline ? { outline } : {}),
    refs: Object.freeze(refs),
    complete: snapshot.complete,
    ...(continuationToken ? { continuation: continuationToken } : {}),
    digest: sha256(canonicalJson(digestPayload)),
  });
}

function selectTab(tabsValue: unknown, requestedTitle?: string): string {
  const tabs = asArray(tabsValue).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  if (!tabs.length) throw new Error("browser binding returned no tabs");
  if (requestedTitle) {
    const exact = tabs.filter((tab) => tab.title === requestedTitle);
    if (exact.length !== 1)
      throw new Error("requested tab title is absent or ambiguous");
    const tabId = optionalString(exact[0]!.tab_id);
    if (!tabId) throw new Error("browser binding returned a malformed tab ID");
    return tabId;
  }
  const active = tabs.filter((tab) => tab.active === true);
  if (active.length === 1) {
    const tabId = optionalString(active[0]!.tab_id);
    if (!tabId)
      throw new Error("browser binding returned a malformed active tab ID");
    return tabId;
  }
  if (tabs.length === 1) {
    const tabId = optionalString(tabs[0]!.tab_id);
    if (!tabId) throw new Error("browser binding returned a malformed tab ID");
    return tabId;
  }
  throw new Error("browser tab selection is ambiguous");
}

function safeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("browser URL must use http or https");
  return parsed.origin;
}

function assertAllowedOrigin(
  url: string | undefined,
  allowedOrigins: readonly string[],
): void {
  if (!url)
    throw new Error("browser observation did not prove its current URL");
  const current = safeOrigin(url);
  if (!allowedOrigins.includes(current))
    throw new Error(`browser origin ${current} is outside the run allowlist`);
}

async function bindWindow(
  driver: DriverClient,
  session: string,
  pid: number,
  windowId: number,
  tabTitle?: string,
  signal?: AbortSignal,
): Promise<BoundBrowser> {
  const response = await driver.call(
    "get_browser_state",
    {
      pid,
      window_id: windowId,
      session,
    },
    signal ? { signal } : undefined,
  );
  if (response.status !== "ok" || response.mode !== "bind")
    throw new Error("browser window binding is not ready");
  if (response.binding_quality !== "exact") {
    throw new Error("browser window binding is not exact");
  }
  if (response.mutation_allowed !== true)
    throw new Error("browser window binding is read-only");
  const targetId = optionalString(response.target_id);
  if (!targetId) throw new Error("browser binding returned no target ID");
  return Object.freeze({
    targetId,
    tabId: selectTab(response.tabs, tabTitle),
    privateState: true,
  });
}

async function waitForPreparedWindow(
  driver: DriverClient,
  session: string,
  pid: number,
  signal?: AbortSignal,
): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    signal?.throwIfAborted();
    const response = await driver.call(
      "list_windows",
      { pid, on_screen_only: true },
      signal ? { signal } : undefined,
    );
    const windows = asArray(response.windows).filter(
      (value): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
    );
    const visible = windows.filter(
      (window) =>
        window.is_on_screen === true &&
        typeof window.window_id === "number" &&
        Number.isInteger(window.window_id) &&
        window.window_id > 0,
    );
    if (visible.length === 1) return visible[0]!.window_id as number;
    if (visible.length > 1) {
      const ranked = visible
        .filter((window) => typeof window.window_id === "number")
        .map((window) => {
          const bounds = asRecord(
            window.bounds ?? {},
            "window bounds are malformed",
          );
          const width = typeof bounds.width === "number" ? bounds.width : 0;
          const height = typeof bounds.height === "number" ? bounds.height : 0;
          return { id: window.window_id as number, area: width * height };
        })
        .sort((left, right) => right.area - left.area);
      if (ranked.length >= 2 && ranked[0]!.area > ranked[1]!.area)
        return ranked[0]!.id;
      throw new Error("prepared browser window selection is ambiguous");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("prepared browser window did not become available");
}

export async function resolveBrowserTarget(
  driver: DriverClient,
  target: BrowserTarget,
  session: string,
  allowedOrigins: readonly string[],
  signal?: AbortSignal,
): Promise<BoundBrowser> {
  if (target.kind === "bound") {
    return Object.freeze({
      targetId: target.targetId,
      tabId: target.tabId,
      privateState: true,
    });
  }
  if (target.kind === "window") {
    return bindWindow(
      driver,
      session,
      target.pid,
      target.windowId,
      target.tabTitle,
      signal,
    );
  }

  const startOrigin = safeOrigin(target.startUrl);
  if (!allowedOrigins.includes(startOrigin))
    throw new Error("isolated browser start URL is outside the run allowlist");
  const prepared = await driver.call(
    "browser_prepare",
    {
      session,
      allow_launch: true,
      profile: { mode: "isolated_new" },
    },
    signal ? { signal } : undefined,
  );
  const pid = Number(prepared.prepared_pid);
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("browser preparation returned an invalid PID");
  const windowId = await waitForPreparedWindow(driver, session, pid, signal);
  const bound = await bindWindow(
    driver,
    session,
    pid,
    windowId,
    undefined,
    signal,
  );
  await driver.call(
    "browser_navigate",
    {
      session,
      target_id: bound.targetId,
      tab_id: bound.tabId,
      url: target.startUrl,
    },
    signal ? { signal } : undefined,
  );
  return Object.freeze({ ...bound, privateState: false });
}

export async function observeBrowser(
  driver: DriverClient,
  bound: BoundBrowser,
  session: string,
  allowedOrigins: readonly string[],
  signal?: AbortSignal,
): Promise<BrowserObservation> {
  const pages: BrowserObservation[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 4; page += 1) {
    signal?.throwIfAborted();
    const response = await driver.call(
      "get_browser_state",
      {
        session,
        target_id: bound.targetId,
        tab_id: bound.tabId,
        snapshot_format: "semantic_v2",
        ...(continuation ? { continuation } : {}),
      },
      signal ? { signal } : undefined,
    );
    const observation = parseBrowserObservation(
      response,
      bound.targetId,
      bound.tabId,
    );
    assertAllowedOrigin(observation.url, allowedOrigins);
    if (pages[0] && observation.url !== pages[0].url) {
      throw new Error(
        "browser page changed while reading a semantic continuation",
      );
    }
    if (pages[0] && observation.snapshotId !== pages[0].snapshotId) {
      throw new Error(
        "browser snapshot changed while reading a semantic continuation",
      );
    }
    pages.push(observation);
    if (observation.complete || !observation.continuation) break;
    continuation = observation.continuation;
  }
  return mergeObservationPages(pages);
}

function mergeObservationPages(
  pages: readonly BrowserObservation[],
): BrowserObservation {
  const first = pages[0];
  const last = pages.at(-1);
  if (!first || !last)
    throw new Error("browser observation returned no semantic pages");
  if (pages.length === 1) return first;
  const refs = pages.flatMap((page) => page.refs);
  if (new Set(refs.map((ref) => ref.ref)).size !== refs.length) {
    throw new Error("browser continuation repeated an action ref");
  }
  const outline = pages
    .map((page) => page.outline)
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const digest = sha256(
    canonicalJson({
      url: first.url,
      title: first.title ?? null,
      outline: outline || null,
      complete: last.complete,
      refs: refs.map((ref) => ({
        role: ref.role,
        name: ref.name,
        value: ref.value ?? null,
        actions: [...ref.actions],
        disabled: ref.disabled,
        frame: ref.frame,
        visibility: ref.visibility,
      })),
    }),
  );
  return Object.freeze({
    targetId: first.targetId,
    tabId: first.tabId,
    snapshotId: first.snapshotId,
    url: first.url,
    ...(first.title ? { title: first.title } : {}),
    ...(outline ? { outline } : {}),
    refs: Object.freeze(refs),
    complete: last.complete,
    ...(last.continuation ? { continuation: last.continuation } : {}),
    digest,
  });
}

export function verifySuccess(
  observation: BrowserObservation,
  condition: SuccessCondition,
  values: readonly ValueSlot[],
): boolean {
  if (condition.kind === "exact_url") {
    const current = new URL(observation.url);
    return (
      current.origin === condition.origin &&
      current.pathname === condition.pathname &&
      current.search === "" &&
      current.hash === ""
    );
  }
  if (condition.kind === "url_includes")
    return observation.url?.includes(condition.value) === true;
  if (condition.kind === "text_present") {
    const needle = condition.value.toLocaleLowerCase("en-US");
    if (observation.outline?.toLocaleLowerCase("en-US").includes(needle))
      return true;
    return observation.refs.some((ref) =>
      `${ref.name} ${ref.value ?? ""}`
        .toLocaleLowerCase("en-US")
        .includes(needle),
    );
  }
  if (condition.kind === "exact_control_visible") {
    const current = new URL(observation.url);
    if (
      current.origin !== condition.page.origin ||
      current.pathname !== condition.page.pathname ||
      current.search !== "" ||
      current.hash !== ""
    ) {
      return false;
    }
    const matches = observation.refs.filter(
      (ref) =>
        !ref.disabled &&
        ref.role === condition.control.role &&
        ref.name === condition.control.name &&
        ref.frame === "main" &&
        ref.visibility === "in_viewport" &&
        ref.actions.includes(condition.requiredAction),
    );
    return matches.length === 1;
  }
  const slotId =
    condition.kind === "exact_field_equals"
      ? condition.inputId
      : condition.valueSlotId;
  const slot = values.find((value) => value.id === slotId);
  if (!slot)
    throw new Error("success condition references an unknown value slot");
  if (condition.kind === "exact_field_equals") {
    const current = new URL(observation.url);
    if (
      current.origin !== condition.page.origin ||
      current.pathname !== condition.page.pathname ||
      current.search !== "" ||
      current.hash !== ""
    ) {
      return false;
    }
    const matches = observation.refs.filter(
      (ref) =>
        ref.role === condition.field.role &&
        ref.name === condition.field.name &&
        ref.frame === "main" &&
        ref.visibility === "in_viewport",
    );
    return matches.length === 1 && matches[0]!.value === slot.value;
  }
  const target = condition.fieldName.toLocaleLowerCase("en-US");
  return observation.refs.some(
    (ref) =>
      ref.name.toLocaleLowerCase("en-US") === target &&
      ref.value === slot.value,
  );
}

export function withSession(
  arguments_: Readonly<Record<string, JsonValue>>,
  session: string,
): Record<string, JsonValue> {
  return { ...arguments_, session };
}
