import { describe, expect, it } from "vitest";
import { describeAgentError } from "../../engine/host/errors.js";

// Gemini's quota error as the app showed it: JSON inside a string inside JSON.
const geminiQuota = Object.assign(
  new Error(
    JSON.stringify({
      error: {
        message: JSON.stringify(
          {
            error: {
              code: 429,
              message:
                "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.5-flash-lite",
              status: "RESOURCE_EXHAUSTED",
              details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "4s" }],
            },
          },
          null,
          2,
        ),
        code: 429,
        status: "Too Many Requests",
      },
    }),
  ),
  { status: 429 },
);

describe("errors from the AI providers, for the chat", () => {
  it("says a quota error plainly, with when to try again and where the plan is", () => {
    const text = describeAgentError(geminiQuota, "gemini-3.5-flash-lite");
    expect(text).toBe("Google says this key has hit its usage limit, the free tier's limit. Try again in 4 seconds, or check your plan at aistudio.google.com.");
    expect(text).not.toMatch(/[{}"\\]/);
  });

  it("tells a refused key, a missing model, a busy service and a lost connection apart", () => {
    expect(describeAgentError(Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { status: 401 }), "claude-opus-5-5")).toBe(
      "Anthropic did not accept the API key. Check it in Settings (or add a new one), then try again.",
    );
    expect(describeAgentError(Object.assign(new Error("404 The model `gpt-6-luna` does not exist"), { status: 404 }), "gpt-6-luna")).toBe("GPT-6 Luna is not available with this key. Pick another model in the chat.");
    expect(describeAgentError(Object.assign(new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { status: 529 }), "claude-sonnet-5-5")).toBe("Anthropic is busy right now. Try again in a moment.");
    expect(describeAgentError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }), "gpt-6-astra")).toBe("Could not reach OpenAI. Check the internet connection, then try again.");
  });

  it("keeps anything else to its first readable sentence", () => {
    expect(describeAgentError(Object.assign(new Error('400 {"error":{"message":"Invalid value for tools[3]. Expected an object, got a string. See the docs."}}'), { status: 400 }), "gpt-6-astra")).toBe(
      "OpenAI could not take this request: Invalid value for tools[3].",
    );
  });
});
