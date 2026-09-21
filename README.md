# Jev Cua: Guarded General Mac Computer Use + Fastpath

`jev-cua` is a local Codex/Waku plugin for app-agnostic Mac computer use. It can launch an exact installed app, inspect Accessibility state, return in-memory screenshots, target visually through opaque grids, click, type non-secret text, press bounded keys, invoke exact menu items, and scroll. The optional compiled path remains available for faster reviewed browser workflows.

```text
general task -> exact app/window -> Accessibility actions when available
                               -> screenshot + opaque visual targeting fallback
             -> one opaque action -> approval when consequential
             -> fresh rebind + exact postcondition -> repeat

repetitive task -> optional Jev workflow recommendation -> local validation
                -> compiled adapter -> deterministic action -> exact postcondition
```

This release does not establish a “1000x” speedup; that still requires end-to-end measurement. It does replace the old Accessibility-only prototype with a usable general Mac path while retaining deterministic verification and at-most-once execution.

## General Mac computer use

- `jev_cua_native_start` returns opaque refs for installed apps. A stopped app is marked `launchable` only when it has an exact installed path; `jev_cua_native_launch_app` accepts only that ref, passes no URL or arguments, launches in the background, and independently verifies the resulting process identity.
- Accessibility observation publishes prebound AXPress, `set_value`, synthetic `type_text`, safe navigation keys, approval-gated Return/Space/Delete, bounded scrolling, and exact menu leaves with display-only breadcrumbs. The Apple and application menus, power/session commands, force quit, quit/close commands, unsafe menu branches, secure fields, and credential-labelled fields are omitted.
- When Accessibility targeting is incomplete, `jev_cua_native_visual_observe` requests informed consent before returning the exact window PNG plus 64 opaque regions. `jev_cua_native_visual_refine` returns one zoomed JPEG plus 64 opaque click actions. Screenshots go to the connected AI client/model and cannot be reliably redacted, so never approve a window showing secrets. Coordinates remain local. Before a visual click, the server recaptures both images and refuses stale pixels. The click still requires an Accessibility-observable semantic postcondition; pixel change alone is never proof of the intended effect.
- App names, window titles, UI labels, and screenshots are untrusted observations. They are never instructions or approval. Executable bundle IDs, PIDs, window IDs, element tokens, menu paths, keys, and coordinates remain inside the server.
- Every visual click and every action classified private or consequential receives an `approval_required` action ref. Approval is one-shot and bound to the exact operation, target, text/action summary, and current observation.
- Text entry rejects recognizable credentials and secure fields, but this is best-effort. `type_text` additionally requires one exact `value_equals` postcondition tied to the bound text control and verifies that value through fresh readback. Never pass passwords, API keys, recovery codes, OTPs, or other secrets; MCP arguments and approval forms may be logged by the client.
- Every mutation requires a caller-supplied postcondition. The server checks it before approval, again after approval, rebinds the exact target immediately before dispatch, observes again afterward, and treats the Cua receipt only as delivery evidence. Only `verified` is success.
- Every operation key is reserved in a content-free durable ledger before dispatch. Never replay an attempted, interrupted, timed-out, refuted, or unknown mutation under the same or a new key. Reconcile the real app state first.
- One run owns an exclusive physical-desktop lease and a persistent Cua session. Always call `jev_cua_native_end`.

Typical semantic path:

```text
jev_cua_doctor
  -> jev_cua_native_start
  -> optional jev_cua_native_launch_app
  -> jev_cua_native_list_windows
  -> jev_cua_native_observe
  -> jev_cua_native_step
  -> reobserve or jev_cua_native_end
```

Visual fallback:

```text
jev_cua_native_visual_observe
  -> user approves disclosure of the exact selected window pixels
  -> select one returned opaque region_ref from the PNG grid
  -> jev_cua_native_visual_refine
  -> select one approval_required click action_ref from the JPEG grid
  -> jev_cua_native_step with an exact semantic Accessibility postcondition
```

The visual fallback currently targets clicks whose intended result remains observable through Accessibility. Text entry and key presses require a returned Accessibility capability. Fully AX-unobservable canvases and remote-desktop surfaces are intentionally not claimed as supported because screenshot motion cannot safely prove the intended action succeeded.

Prefer a purpose-built connector, API, or CLI when one covers the task. Those surfaces are faster and easier to verify. Use the compiled mode below when a repeated browser task exactly matches a reviewed workflow.

## Compiled fast-path contract

- Live runs require one enabled manifest pinned by exact ID, version, and SHA-256 digest.
- Inspect the complete shadow plan before live execution. If any step is `r3_consequential` or `r4_forbidden`, refuse the entire live plan so an earlier reversible prefix cannot run before the controller reaches the blocked step.
- The controller launches a fresh isolated Cua browser profile. Named/authenticated profiles are unsupported in v0.1.
- The bootstrap URL is HTTPS, credential-free, query-free, fragment-free, origin-allowlisted, and declared as a reviewed read-only landing navigation.
- Each step is `type`, `click`, or a bounded scroll to reveal an exact reviewed control.
- The deterministic policy executes only when the compiler exposes one automatically allowed action. Multiple executable actions select the closed-set abstain route; zero workflow actions trigger bounded reobservation and then fail `unknown` if no reviewed step appears. It cannot invent URLs, selectors, values, coordinates, or Cua calls.
- Optional Jev routing maps a redacted request to opaque enabled-workflow choices plus `no match`. It is recommendation-only, is not calibrated for auto-execution, and never receives executable arguments.
- The controller reobserves immediately before dispatch and rejects stale or ambiguous controls.
- A step advances only when its exact, page-bound `ensures` condition is true. A Cua success receipt, including `unverifiable`, never advances the workflow by itself.
- Exact terminal success present at startup returns without a Jev call or semantic action. Already-satisfied steps are reconciled without replay.
- Consequential and forbidden actions are not executed. Semantic risk patterns can raise—but never lower—the risk declared by a manifest.
- Once a mutation is attempted, every nonterminal exit requires reconciliation and never recommends fallback/replay.
- The requested browser delivery route is a least-authority boundary: DOM-only steps reject accessibility, global-input, or other silent fallback receipts. Session cleanup is explicit in every completed result; an unconfirmed cleanup fails closed as `unknown` with reconciliation required.
- A durable global execution barrier is written before browser setup. Production clears it only after positive session cleanup and either no attempted mutation or a verified terminal result. Unconfirmed cleanup, process death, and nonterminal post-mutation outcomes quarantine all later live runs across restarts.
- The global desktop lease, execution barrier, and at-most-once ledger use a fixed per-user directory, independent of caller-configurable trace storage. The guarantee is per caller-supplied run key; a different key, deleted state, or an out-of-band action is outside it.

The live runtime accepts exactly Cua Driver `0.28.2`, checks its advertised action-receipt schemas, and on macOS verifies the installed `/Applications/CuaDriver.app` signature against identifier `com.trycua.driver` and team `YCK386LBJ7`. A caller-supplied driver binary is not accepted for live macOS use.

## Data boundary

Native execution and exact compiled workflow execution send nothing to TypeSafe. They remain local apart from the target app or website and Cua Driver.

When the optional `jev_cua_route_workflow` tool is called, TypeSafe receives only:

- a normalized, truncated, best-effort-redacted request;
- redacted reviewed descriptions of enabled workflows; and
- fresh opaque option IDs, including an explicit no-match option.

The router has no separate native-UI, workflow-ID, digest, page-URL/origin, title, outline, raw-page-content, semantic-ref, action-argument, coordinate, or workflow-input fields. The normalized user request and reviewed workflow descriptions could themselves mention a URL or origin, so this is not a categorical URL-exclusion guarantee. Redaction is not a DLP guarantee; do not route a request containing secrets or sensitive page content. Cua and the target app or page still process locally dispatched actions. `allowed_disclosure_origins` records the human-reviewed recipient page; it is not a network/DLP firewall, because scripts on that page may transmit data elsewhere.

Review TypeSafe’s [privacy policy](https://typesafe.ai/legal/privacy-policy) and [data-processing terms](https://typesafe.ai/legal/data-processing) before real data is used.

## Threat-model limits

The plugin is a reliability and least-authority layer inside Codex/Waku, not a hard sandbox against an agent with unrestricted same-user shell or computer access. Such an agent can edit local manifests, write login-Keychain items, bypass this MCP and invoke Cua directly, or deliberately race a verified executable path between signature checking and process launch.

The Keychain workflow digest is therefore a tamper-evident local trust pin, not proof of fresh human presence. A hard security boundary requires a separately trusted service/OS identity that owns the Cua credential and any optional TypeSafe credential, exposes only this narrow protocol, uses a bounded Cua capability manifest, and obtains OS-backed user-presence approvals. Native mode can execute a bound consequential action only after the connected MCP client accepts its exact one-shot form; secure or credential-labelled fields and recognizable credential strings may be blocked, but the plugin cannot prove arbitrary text is safe. It exposes screenshots to the connected caller but keeps executable coordinates, app identities, native refs, menu paths, and bounded key values inside the server. It does not expose app quit, force quit, power/session commands, arbitrary hotkeys, credential entry, or secret-safe typing. Compiled v0.1 does not auto-execute external submissions, sends, purchases, publications, permissions, uploads, deletion, credential entry, or other consequential work.

An exact origin, path, label, and local manifest do not attest the behavior of the remote site. A compromised site can preserve reviewed labels while changing what a nominally reversible control does, and postcondition checks necessarily occur after dispatch. Re-review and version-bump a workflow whenever the site changes; do not treat this plugin as protection from a malicious origin.

## Setup

Requirements:

- macOS and Node.js 24.21+
- the signed Cua Driver `0.28.2` application in `/Applications`
- Cua Accessibility and Screen Recording permissions for live use
- for compiled browser workflows or benchmarks only, a clean vendor-signed Cua-compatible Chromium browser; Google Chrome is the validated primary browser and Edge may remain installed as Cua's fallback
- a TypeSafe API key only for optional intent routing and the experimental Jev benchmark arm; native and exact compiled execution do not need one

The MCP launcher deliberately uses Homebrew's isolated Node 24 runtime when it
is present. TypeSafe SDK 0.6.0 has a confirmed cancellation crash on supported
Node 20/22 releases; Node 24.21 is the verified workaround. Install it without
changing your default Node version:

```bash
brew install node@24
# Optional: needed only for the compiled browser mode and benchmark.
brew install --cask google-chrome
```

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install
npm run check
cua-driver telemetry disable
cua-driver permissions grant
/usr/bin/security add-generic-password -U \
  -s ai.typesafe.jev-cua \
  -a typesafe-api-key \
  -w
```

Enter the TypeSafe API key only at the resulting Keychain prompt. Keeping bare
`-w` as the final argument prevents the secret from appearing in shell history
or process arguments.

List the workflow to obtain its exact digest, review the manifest, then pin that digest:

```bash
/usr/bin/security add-generic-password -U \
  -s ai.typesafe.jev-cua.workflow \
  -a '<workflow-id>@<version>' \
  -w '<64-character-workflow-digest>'
```

You may call `jev_cua_list_workflows` and inspect a compiled `shadow_plan` without Cua being ready: both are local and shadow launches no browser or TypeSafe service. Run `jev_cua_doctor` and require `ready` before `jev_cua_native_start` or any compiled `live` attempt. For native work, select exactly one plausible installed app; if it is stopped and marked `launchable`, launch it with a unique operation key, then select exactly one plausible window. Prefer semantic observation. Use the two-stage visual fallback only when Accessibility cannot identify the target but can still evaluate the intended postcondition. For compiled work, if the request does not clearly identify a workflow and is safe to disclose to TypeSafe after best-effort redaction, call `jev_cua_route_workflow` with `acknowledge_typesafe_disclosure: true`; it can return a recommendation but never runs the result. Confirm the returned ID, version, digest, inputs, and approval against the local workflow list. Use a new shadow-only run key to inspect the complete static `shadow_plan`. Refuse live execution if any step is r3 or r4; otherwise, if the plan is correct, use a distinct new key for the live attempt. Never mint another live key to replay an uncertain action.

### Recovering a quarantined live run

There is intentionally no MCP tool that clears the execution barrier or acknowledges an uncertain operation. If `jev_cua_doctor` reports `live_execution_safety`, `durable_runs`, or `native_operations` as blocked, a trusted human must personally use this procedure from an interactive trusted terminal. The human must reconcile the real state and type the acknowledgement; an agent must not automate either step. Start in the plugin root (the directory containing this README and `package.json`):

1. Record the exact `runId`, `session`, barrier owner, and blocker class shown by the doctor. For a compiled workflow, inspect the record with its original run key using `jev_cua_get_run`. Native operation records deliberately contain no UI content or executable arguments and are not exposed through that workflow lookup. Compiled sessions use the reported `jev-cua-...` identity; native sessions use `jev-cua-native-` followed by 16 lowercase hexadecimal characters.
2. Run `cua-driver sessions --json`. Recovery requires zero live Cua sessions globally, not merely the absence of the affected session. Revoke each live session by its exact identifier, then run `sessions --json` again and confirm the global list is empty.
3. Personally reconcile the target app or site's real state. Ending every session does not prove that a UI or server-side effect did or did not happen.
4. From an interactive trusted terminal, run the local recovery command with those exact identifiers:

   ```bash
   npm run reconcile-live -- \
     --run-id '<run-id>' \
     --session '<session>'
   ```

5. As the trusted human, review the displayed identity and personally type the exact requested `RECONCILED <run-id>` phrase. Do not delegate or automate this acknowledgement. This interactive phrase provides deliberate audit friction; it is not OS-backed proof of human presence, and malware running as the same user can automate it. The command refuses noninteractive input, any live Cua session anywhere on the machine, an untrusted Cua installation, and mismatched identities. For a compiled run it writes a private acknowledgement bound to the exact run record. For a native run it marks matching active native-operation records reconciled without making them replayable. It then archives the owner-matched execution barrier when one remains.

6. Run `jev_cua_doctor` again. Resume live work only when the execution barrier, durable-run scan, and native-operation scan all report unblocked. The archived barrier, reconciliation acknowledgement, and permanently reserved original ledger entries form the retained audit trail.

The checked-in reference workflow is intentionally disabled. The bundled entrypoint is `mcp/server.cjs`.

Do not recursively strip signing metadata from a personal browser to make it pass Cua's strict executable check. Use a clean, dedicated browser installation and verify its signature instead.

## Contract-reproducible benchmark

The owned fixture is deployed at `https://jev-cua-benchmark-fixture.erons.workers.dev/v6/catalog-search`. The runner pins its exact version, response SHA-256, complete security-header set, workflow digest, fixed public inputs, controller settings, model identities, and seeded order. It records the installed Cua and browser executable SHA-256 digests, the actual TypeSafe SDK version, and the package-lock digest. It fetch-verifies the HTTP contract immediately before every trial and after the batch. The page visibly states the exact fixture contract, and every executable field/control has that V6 contract marker in its exact accessible name; a candidate cannot exist against an unversioned lookalike. Each trial opens a fresh isolated browser profile and performs the same three-step catalog QA task: type `chicken`, sort price low-to-high, and enable the sale filter.

That two-sided check is strong drift detection, not a cryptographic binding between the separately fetched bytes and the page Cua observes. A malicious or split-serving origin could theoretically return the pinned body to the verifier and a different page carrying the same marker to the browser. Keep the fixture on an isolated owned origin; do not generalize this benchmark trust model to an untrusted site.

“Contract-reproducible” does not mean model-weight reproducible. `jev-1.13.0` is a remote service identity, and TypeSafe can change infrastructure or behavior behind that name without supplying a weight or service-revision attestation. Reports are evidence for the observed dates and recorded contract, not a promise that later provider behavior will match.

Run the credential-free deterministic baseline:

```bash
npm run benchmark -- \
  --arm deterministic \
  --pairs 30 \
  --warmup-pairs 3 \
  --seed catalog-search-v1
```

After the TypeSafe key is in Keychain, run the balanced paired comparison:

```bash
npm run benchmark -- \
  --arm both \
  --pairs 30 \
  --warmup-pairs 3 \
  --seed catalog-search-v1
```

The primary latency is monotonic elapsed time around `controller.run()`. Keychain lookup, fixture verification, and Cua readiness preflight are deliberately outside that timed interval. Durable JSONL trace writes, fsyncs, and positively confirmed session cleanup remain inside it, matching production controller behavior. Ambient controller-tuning environment variables are ignored. The runner:

- rechecks the signed Cua runtime, tool contract, health, permissions, and disabled telemetry before every trial;
- balances adjacent Jev-first and deterministic-first pairs;
- records verified completion with Wilson intervals, paired completion outcomes with exact McNemar analysis, all-outcome latency, both-verified paired latency, action timing, actual Cua delivery routes/effects, and known returned token usage;
- marks provider-failure token usage unknown because a timed-out request may still have consumed billable tokens;
- rejects a verified result unless it contains exactly three ordered execute decisions, actions, receipts, and postconditions; bounded read-only `reobserve` decisions are counted separately; and
- never retries the same run. The disposable fixture may continue with the next statistically independent trial only after positive isolated-session cleanup; unproven cleanup, runtime drift, fixture drift, cancellation, or contamination stops the batch.

Reports and content-free traces are written under ignored `benchmark-results/` directories with modes `0700` and `0600`. One exclusive batch lease prevents two schedules from interleaving. A dirty/unavailable source tree or mismatched installed TypeSafe SDK stops before a browser trial; the source commit and worktree are checked again after the batch. Every terminal stop marks measurements invalid and publishes no statistical summary. An interrupted batch remains marked `running`; the runner refuses to start another batch until its durable ledger is inspected. Do not use the keyboard or browser during a batch: the desktop lease excludes other compliant controllers, not a human or a process that invokes Cua directly.

The report records installed Chrome and Edge versions and executable digests, but Cua 0.28.2 does not identify the launched browser executable in its `browser_prepare` receipt. Treat those fields as environment inventory, not proof that a particular trial used either browser.

At each decision, the compiled controller exposes only the next executable reviewed step plus three stop routes. Production uses the deterministic arm. The Jev arm is retained as an experimental ablation that measures the model's marginal latency, token cost, and veto/reobserve behavior inside that controller; it cannot demonstrate better planning, general computer-use reasoning, or a “1000x” improvement. Thirty measured trials per arm are exploratory: even 30/30 verified gives only about an 88.6% Wilson lower bound, and its p95 estimate is unstable.

## Why Cua + Jev

Cua’s semantic snapshots and exact refs address UI grounding; they do not supply workflow authorization, durable idempotency, or postcondition semantics. The compiler and controller supply that state machine and fail closed when the page, receipt schema, decision, or evidence falls outside its contract. Asking Jev to select the sole already-proven next step added latency and false rejection without adding information, so exact execution is deterministic. Jev is reserved for the genuinely semantic problem of mapping an ambiguous request across multiple reviewed workflows, and even there it only recommends an opaque local choice.

Relevant upstream material: [Cua Driver installation](https://cua.ai/docs/how-to-guides/driver/install), [agent connection](https://cua.ai/docs/how-to-guides/driver/connect-your-agent), and [semantic snapshots](https://cua.ai/docs/reference/cua-driver/browser-semantic-snapshots).
