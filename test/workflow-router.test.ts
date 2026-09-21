import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadRuntimeConfig } from "../src/config.js";
import {
  TypeSafeWorkflowIntentRouter,
  type WorkflowRouteDefinition,
} from "../src/jev/workflow-router.js";

type CapturedRequest = {
  model: string;
  state: {
    user_request: string;
    enabled_workflows: Array<{
      option_id: string;
      description: string;
    }>;
  };
  questions: Record<string, unknown> & {
    route: { criteria: Record<string, unknown> };
  };
};

type MutableProviderResponse = {
  model: unknown;
  answers: Record<string, unknown>;
  usage: Record<string, unknown>;
  [key: string]: unknown;
};

const workflows: readonly WorkflowRouteDefinition[] = Object.freeze([
  Object.freeze({
    id: "invoice_export_v2",
    enabled: true,
    description: "Export paid invoices to a CSV file.",
  }),
  Object.freeze({
    id: "disabled_price_watch",
    enabled: false,
    description: "Monitor a competitor's prices.",
  }),
  Object.freeze({
    id: "customer_onboarding_v7",
    enabled: true,
    description: "Create a customer onboarding checklist in the CRM.",
  }),
]);

function capturedRequest(value: unknown): CapturedRequest {
  return value as CapturedRequest;
}

function optionIds(request: CapturedRequest): {
  workflow: string[];
  noMatch: string;
} {
  const workflow = request.state.enabled_workflows.map(
    (entry) => entry.option_id,
  );
  const noMatch = Object.keys(request.questions.route.criteria).find(
    (optionId) => !workflow.includes(optionId),
  );
  assert.ok(noMatch);
  return { workflow, noMatch };
}

function providerResponse(
  request: CapturedRequest,
  winner: number | "no_match" = 0,
): MutableProviderResponse {
  const ids = optionIds(request);
  const selected = winner === "no_match" ? ids.noMatch : ids.workflow[winner]!;
  const probabilities = Object.fromEntries(
    [...ids.workflow, ids.noMatch].map((optionId) => [optionId, 0]),
  );
  probabilities[selected] = 0.95;
  probabilities[selected === ids.noMatch ? ids.workflow[0]! : ids.noMatch] =
    0.05;
  const answers: Record<string, unknown> = {
    route: {
      type: "choice",
      choice: selected,
      confidence: 0.96,
      probabilities,
    },
    has_direct_match: {
      type: "noul",
      noul: winner === "no_match" ? 0.02 : 0.98,
    },
  };
  for (const [index] of ids.workflow.entries()) {
    answers[`workflow_fit_${index}`] = {
      type: "noul",
      noul: winner === index ? 0.97 : 0.02,
    };
  }
  return {
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 73, output_tokens: 11 },
  };
}

describe("TypeSafe workflow intent router", () => {
  test("sends only opaque enabled options and maps a gated ranking locally", async () => {
    const captured: Array<{ request: CapturedRequest; options: unknown }> = [];
    const fakeClient = {
      systemOne: async (rawRequest: unknown, options: unknown) => {
        const request = capturedRequest(rawRequest);
        captured.push({ request, options });
        return providerResponse(request, 1);
      },
    };
    const router = new TypeSafeWorkflowIntentRouter(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    const controller = new AbortController();
    const result = await router.route({
      request:
        "Please onboard the new client alice@example.test using token-supersecret123456.",
      workflows,
      signal: controller.signal,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.request.model, "jev-1.13.0");
    assert.deepEqual(captured[0]!.options, { signal: controller.signal });
    const ids = optionIds(captured[0]!.request);
    assert.equal(new Set([...ids.workflow, ids.noMatch]).size, 3);
    assert.equal(
      [...ids.workflow, ids.noMatch].some((id) =>
        workflows.some((workflow) => workflow.id === id),
      ),
      false,
    );
    assert.match(captured[0]!.request.state.user_request, /onboard/u);

    const payload = JSON.stringify(captured[0]!.request);
    assert.equal(payload.includes("invoice_export_v2"), false);
    assert.equal(payload.includes("customer_onboarding_v7"), false);
    assert.equal(payload.includes("disabled_price_watch"), false);
    assert.equal(payload.includes("Monitor a competitor's prices"), false);
    assert.equal(payload.includes("alice@example.test"), false);
    assert.equal(payload.includes("token-supersecret123456"), false);
    assert.equal(payload.includes("[email]"), true);
    assert.equal(payload.includes("[credential]"), true);

    assert.equal(result.outcome, "recommendation");
    assert.equal(result.recommendedWorkflowId, "customer_onboarding_v7");
    assert.equal(result.choiceWorkflowId, "customer_onboarding_v7");
    assert.deepEqual(
      result.recommendations.map((recommendation) => ({
        id: recommendation.workflowId,
        probability: recommendation.probability,
        fit: recommendation.fitProbability,
        selected: recommendation.selectedByChoice,
      })),
      [
        {
          id: "customer_onboarding_v7",
          probability: 0.95,
          fit: 0.97,
          selected: true,
        },
        {
          id: "invoice_export_v2",
          probability: 0,
          fit: 0.02,
          selected: false,
        },
      ],
    );
    assert.equal(result.noMatchProbability, 0.05);
    assert.equal(result.hasDirectMatchProbability, 0.98);
    assert.equal(result.choiceConfidence, 0.96);
    assert.equal(result.probabilityMargin, 0.9);
    assert.deepEqual(result.uncertainty, {
      isUncertain: false,
      reasons: [],
    });
    assert.equal(result.inputTokens, 73);
    assert.equal(result.outputTokens, 11);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.recommendations), true);
  });

  test("returns the explicit no-match path without recommending a workflow", async () => {
    const fakeClient = {
      systemOne: async (rawRequest: unknown) =>
        providerResponse(capturedRequest(rawRequest), "no_match"),
    };
    const router = new TypeSafeWorkflowIntentRouter(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    const result = await router.route({
      request: "Post this announcement to Mastodon.",
      workflows,
    });

    assert.equal(result.outcome, "no_match");
    assert.equal(result.recommendedWorkflowId, null);
    assert.equal(result.choiceWorkflowId, null);
    assert.equal(result.noMatchProbability, 0.95);
    assert.equal(result.hasDirectMatchProbability, 0.02);
    assert.equal(result.uncertainty.isUncertain, false);
    assert.equal(result.recommendations.length, 2);
  });

  test("withholds no-match when an independent workflow-fit answer conflicts", async () => {
    const fakeClient = {
      systemOne: async (rawRequest: unknown) => {
        const response = providerResponse(
          capturedRequest(rawRequest),
          "no_match",
        );
        response.answers.workflow_fit_0 = { type: "noul", noul: 0.97 };
        return response;
      },
    };
    const router = new TypeSafeWorkflowIntentRouter(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    const result = await router.route({
      request: "Export the invoices.",
      workflows,
    });

    assert.equal(result.outcome, "uncertain");
    assert.equal(result.recommendedWorkflowId, null);
    assert.deepEqual(result.uncertainty.reasons, [
      "workflow_fit_conflicts_with_no_match",
    ]);
  });

  test("withholds a recommendation and reports every failed code-owned gate", async () => {
    const fakeClient = {
      systemOne: async (rawRequest: unknown) => {
        const request = capturedRequest(rawRequest);
        const response = providerResponse(request);
        const ids = optionIds(request);
        response.answers.route = {
          type: "choice",
          choice: ids.workflow[0],
          confidence: 0.4,
          probabilities: {
            [ids.workflow[0]!]: 0.6,
            [ids.workflow[1]!]: 0.35,
            [ids.noMatch]: 0.05,
          },
        };
        response.answers.has_direct_match = { type: "noul", noul: 0.4 };
        response.answers.workflow_fit_0 = { type: "noul", noul: 0.45 };
        return response;
      },
    };
    const router = new TypeSafeWorkflowIntentRouter(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    const result = await router.route({
      request: "Maybe export some account information.",
      workflows,
    });

    assert.equal(result.outcome, "uncertain");
    assert.equal(result.recommendedWorkflowId, null);
    assert.equal(result.choiceWorkflowId, "invoice_export_v2");
    assert.deepEqual(result.uncertainty, {
      isUncertain: true,
      reasons: [
        "winner_probability_below_threshold",
        "choice_confidence_below_threshold",
        "winner_margin_below_threshold",
        "selected_workflow_fit_below_threshold",
        "match_gate_below_threshold",
      ],
    });
  });

  test("rejects invalid inputs before calling TypeSafe", async () => {
    let calls = 0;
    const fakeClient = {
      systemOne: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    const router = new TypeSafeWorkflowIntentRouter(
      fakeClient as never,
      loadRuntimeConfig({}),
    );

    await assert.rejects(
      () => router.route({ request: "   ", workflows }),
      /user request must not be empty/u,
    );
    await assert.rejects(
      () => router.route({ request: "Do something", workflows: [] }),
      /at least one enabled workflow/u,
    );
    await assert.rejects(
      () =>
        router.route({
          request: "Do something",
          workflows: workflows.map((workflow) => ({
            ...workflow,
            enabled: false,
          })),
        }),
      /at least one enabled workflow/u,
    );
    await assert.rejects(
      () =>
        router.route({
          request: "Do something",
          workflows: [workflows[0]!, { ...workflows[0]! }],
        }),
      /IDs must be unique/u,
    );
    await assert.rejects(
      () =>
        router.route({
          request: "Do something",
          workflows: [{ id: "broken", enabled: true, description: "" }],
        }),
      /workflow description/u,
    );

    const boundedRouter = new TypeSafeWorkflowIntentRouter(
      fakeClient as never,
      { ...loadRuntimeConfig({}), maxCandidates: 1 },
    );
    await assert.rejects(
      () =>
        boundedRouter.route({
          request: "Do something",
          workflows: [workflows[0]!, workflows[2]!],
        }),
      /configured router bound/u,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() =>
      router.route({
        request: "Do something",
        workflows,
        signal: controller.signal,
      }),
    );
    assert.equal(calls, 0);
  });

  test("redacts secrets that cross the provider length cutoff", async () => {
    for (const [secret, partial, replacement] of [
      ["token-supersecret1234567890", "token-superse", "[credential]"],
      ["alice.long.address@example.test", "alice.long", "[email]"],
    ] as const) {
      let captured: CapturedRequest | undefined;
      const fakeClient = {
        systemOne: async (rawRequest: unknown) => {
          captured = capturedRequest(rawRequest);
          return providerResponse(captured);
        },
      };
      const router = new TypeSafeWorkflowIntentRouter(
        fakeClient as never,
        loadRuntimeConfig({}),
      );
      await router.route({
        request: `${"x".repeat(1_982)} ${secret}`,
        workflows,
      });

      assert.ok(captured);
      assert.equal(captured.state.user_request.includes(secret), false);
      assert.equal(captured.state.user_request.includes(partial), false);
      assert.equal(captured.state.user_request.includes(replacement), true);
      assert.ok(captured.state.user_request.length <= 2_000);
    }
  });

  test("strictly rejects malformed model, usage, answer, and probability data", async (t) => {
    const cases: ReadonlyArray<
      readonly [
        string,
        (
          response: MutableProviderResponse,
          request: CapturedRequest,
        ) => unknown,
        RegExp,
      ]
    > = [
      ["non-object response", () => null, /invalid response/u],
      [
        "extra response field",
        (response) => ({ ...response, request_id: "unexpected" }),
        /response keys/u,
      ],
      [
        "wrong model",
        (response) => ({ ...response, model: "jev-latest" }),
        /pinned model/u,
      ],
      [
        "missing usage field",
        (response) => ({ ...response, usage: { input_tokens: 1 } }),
        /usage keys/u,
      ],
      [
        "fractional token count",
        (response) => ({
          ...response,
          usage: { input_tokens: 1.5, output_tokens: 1 },
        }),
        /input token count/u,
      ],
      [
        "missing answer",
        (response) => {
          delete response.answers.workflow_fit_1;
          return response;
        },
        /answers keys/u,
      ],
      [
        "extra answer",
        (response) => {
          response.answers.injected = { type: "noul", noul: 1 };
          return response;
        },
        /answers keys/u,
      ],
      [
        "extra choice field",
        (response) => {
          response.answers.route = {
            ...(response.answers.route as Record<string, unknown>),
            rationale: "not allowed",
          };
          return response;
        },
        /choice answer keys/u,
      ],
      [
        "unknown choice",
        (response) => {
          (response.answers.route as Record<string, unknown>).choice =
            "real_workflow_id";
          return response;
        },
        /unknown route choice/u,
      ],
      [
        "missing probability",
        (response, request) => {
          const ids = optionIds(request);
          delete (
            (response.answers.route as Record<string, unknown>)
              .probabilities as Record<string, unknown>
          )[ids.workflow[1]!];
          return response;
        },
        /probabilities keys/u,
      ],
      [
        "unknown probability",
        (response) => {
          (
            (response.answers.route as Record<string, unknown>)
              .probabilities as Record<string, unknown>
          ).injected = 0;
          return response;
        },
        /probabilities keys/u,
      ],
      [
        "non-finite probability",
        (response, request) => {
          const ids = optionIds(request);
          (
            (response.answers.route as Record<string, unknown>)
              .probabilities as Record<string, unknown>
          )[ids.workflow[0]!] = Number.NaN;
          return response;
        },
        /invalid route probability/u,
      ],
      [
        "probabilities do not sum to one",
        (response, request) => {
          const ids = optionIds(request);
          const probabilities = (
            response.answers.route as Record<string, unknown>
          ).probabilities as Record<string, unknown>;
          probabilities[ids.workflow[0]!] = 0.85;
          return response;
        },
        /sum to one/u,
      ],
      [
        "choice is not probability maximum",
        (response, request) => {
          const ids = optionIds(request);
          const route = response.answers.route as Record<string, unknown>;
          route.probabilities = {
            [ids.workflow[0]!]: 0.4,
            [ids.workflow[1]!]: 0.55,
            [ids.noMatch]: 0.05,
          };
          return response;
        },
        /maximum-probability/u,
      ],
      [
        "invalid confidence",
        (response) => {
          (response.answers.route as Record<string, unknown>).confidence = 2;
          return response;
        },
        /route confidence/u,
      ],
      [
        "invalid gate type",
        (response) => {
          response.answers.has_direct_match = { type: "choice", noul: 0.9 };
          return response;
        },
        /invalid direct-match gate answer/u,
      ],
      [
        "extra fit answer field",
        (response) => {
          response.answers.workflow_fit_0 = {
            type: "noul",
            noul: 0.9,
            confidence: 1,
          };
          return response;
        },
        /workflow_fit_0 answer keys/u,
      ],
      [
        "out-of-range fit",
        (response) => {
          response.answers.workflow_fit_0 = { type: "noul", noul: -0.1 };
          return response;
        },
        /workflow_fit_0 answer probability/u,
      ],
    ];

    for (const [name, mutate, expected] of cases) {
      await t.test(name, async () => {
        const fakeClient = {
          systemOne: async (rawRequest: unknown) => {
            const request = capturedRequest(rawRequest);
            return mutate(providerResponse(request), request);
          },
        };
        const router = new TypeSafeWorkflowIntentRouter(
          fakeClient as never,
          loadRuntimeConfig({}),
        );
        await assert.rejects(
          () => router.route({ request: "Export the invoices", workflows }),
          expected,
        );
      });
    }
  });
});
