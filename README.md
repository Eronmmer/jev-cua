# Jev Cua Fastpath

`jev-cua` is a local Codex/Waku plugin for repetitive browser workflows whose controls, inputs, effects, and success evidence have been reviewed in advance. MCP is the connector; the workflow compiler, durable controller, Cua integration, and TypeSafe Jev policy live behind it.

```text
exact workflow -> local semantic snapshot -> closed candidates -> Jev veto/selection
               -> fresh snapshot -> one action -> exact postcondition -> repeat
```

This is not a general browser agent and it does not currently prove a “1000x” speedup. Jev receives a small closed decision problem, while deterministic code still owns authorization, dispatch, and verification. Benchmark Jev-on against a deterministic selector before claiming a latency or completion-rate gain.

## Current execution contract

- Live runs require one enabled manifest pinned by exact ID, version, and SHA-256 digest.
- The controller launches a fresh isolated Cua browser profile. Named/authenticated profiles are unsupported in v0.1.
- The bootstrap URL is HTTPS, credential-free, query-free, fragment-free, origin-allowlisted, and declared as a reviewed read-only landing navigation.
- Each step is `type`, `click`, or a bounded scroll to reveal an exact reviewed control.
- Jev chooses only among opaque IDs for locally compiled candidates plus `reobserve`, `abstain`, and `escalate`. It cannot invent URLs, selectors, values, coordinates, or Cua calls.
- The controller reobserves immediately before dispatch and rejects stale or ambiguous controls.
- A step advances only when its exact, page-bound `ensures` condition is true. A Cua success receipt, including `unverifiable`, never advances the workflow by itself.
- Exact terminal success present at startup returns without a Jev call or semantic action. Already-satisfied steps are reconciled without replay.
- Consequential and forbidden actions are not executed. Semantic risk patterns can raise—but never lower—the risk declared by a manifest.
- Once a mutation is attempted, every nonterminal exit requires reconciliation and never recommends fallback/replay.
- The global desktop lease and at-most-once ledger use a fixed per-user directory, independent of caller-configurable trace storage. The guarantee is per caller-supplied run key; a different key, deleted state, or an out-of-band action is outside it.

The live runtime accepts exactly Cua Driver `0.28.2`, checks its advertised action-receipt schemas, and on macOS verifies the installed `/Applications/CuaDriver.app` signature against identifier `com.trycua.driver` and team `YCK386LBJ7`. A caller-supplied driver binary is not accepted for live macOS use.

## Data boundary

TypeSafe receives only:

- the fixed reviewed goal;
- redacted fixed candidate descriptions;
- candidate risk labels and opaque candidate IDs; and
- minimal prior-action metadata.

It does not receive the page URL/origin, title, outline, raw page content, semantic refs, action arguments, coordinates, or workflow input values. Cua and the target page still process locally dispatched values. `allowed_disclosure_origins` records the human-reviewed recipient page; it is not a network/DLP firewall, because scripts on that page may transmit data elsewhere.

Review TypeSafe’s [privacy policy](https://typesafe.ai/legal/privacy-policy) and [data-processing terms](https://typesafe.ai/legal/data-processing) before real data is used.

## Threat-model limits

The plugin is a reliability and least-authority layer inside Codex/Waku, not a hard sandbox against an agent with unrestricted same-user shell or computer access. Such an agent can edit local manifests, write login-Keychain items, bypass this MCP and invoke Cua directly, or deliberately race a verified executable path between signature checking and process launch.

The Keychain workflow digest is therefore a tamper-evident local trust pin, not proof of fresh human presence. A hard security boundary requires a separately trusted service/OS identity that owns the Cua and TypeSafe credentials, exposes only this narrow protocol, uses a bounded Cua capability manifest, and obtains user-presence-bound approvals. v0.1 also does not auto-execute external submissions, sends, purchases, permissions, uploads, deletion, credential entry, or other consequential work.

## Setup

Requirements:

- macOS and Node.js 22+
- the signed Cua Driver `0.28.2` application in `/Applications`
- Cua Accessibility and Screen Recording permissions for live use
- a TypeSafe API key

```bash
npm install
npm run check
cua-driver telemetry disable
cua-driver permissions grant
/usr/bin/security add-generic-password -U \
  -s ai.typesafe.jev-cua \
  -a typesafe-api-key \
  -w '<TYPESAFE_API_KEY>'
```

List the workflow to obtain its exact digest, review the manifest, then pin that digest:

```bash
/usr/bin/security add-generic-password -U \
  -s ai.typesafe.jev-cua.workflow \
  -a '<workflow-id>@<version>' \
  -w '<64-character-workflow-digest>'
```

Run `jev_cua_doctor`, then `jev_cua_list_workflows`. Use a new shadow-only run key to inspect the static `shadow_plan`; shadow launches no browser and calls no TypeSafe service. If the plan is correct, use a distinct new key for the live attempt. Never mint another live key to replay an uncertain action.

The checked-in reference workflow is intentionally disabled. The bundled entrypoint is `mcp/server.cjs`.

## Why Cua + Jev

Cua’s semantic snapshots and exact refs address UI grounding; they do not supply workflow authorization, durable idempotency, or postcondition semantics. The v0.1 compiler exposes only the exact next executable workflow step plus the three stop/reobserve routes, so Jev currently acts as a probabilistic veto—not as a general planner. That extra call may reduce rather than improve speed; benchmark it against a deterministic bypass. The controller supplies the state machine and fails closed when the page, receipt schema, decision, or evidence falls outside its contract.

Relevant upstream material: [Cua Driver installation](https://cua.ai/docs/how-to-guides/driver/install), [agent connection](https://cua.ai/docs/how-to-guides/driver/connect-your-agent), and [semantic snapshots](https://cua.ai/docs/reference/cua-driver/browser-semantic-snapshots).
