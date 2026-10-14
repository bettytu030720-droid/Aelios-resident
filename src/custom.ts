// A provider of your own: any OpenAI-compatible endpoint (a relay, OpenRouter, Nous, …) or any
// Anthropic-compatible one (Anthropic itself, a relay speaking the Messages API), with your key.
// Picked like any model, as `custom/<the provider's own model id>`. The resident calls it straight
// from the Worker, not through AI Gateway, so neither unified billing nor the Gateway's catalog applies.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { withoutOldThinkingIn } from "./claude-run";

export const CUSTOM_PREFIX = "custom/";

export function isCustom(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** The Messages request without thinking from earlier turns, for the reason in claude-run.ts. */
const withoutOldThinking: typeof fetch = (input, init) => {
  if (typeof init?.body !== "string") return fetch(input, init);
  const body = JSON.parse(init.body) as Record<string, unknown>;
  return fetch(input, { ...init, body: JSON.stringify(withoutOldThinkingIn(body)) });
};

/** `custom/<model>` as a model: CUSTOM_BASE_URL (up to /v1), CUSTOM_API_KEY, CUSTOM_FORMAT openai or anthropic. */
export function customModel(env: Env, id: string): LanguageModel {
  const baseURL = env.CUSTOM_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseURL) throw new Error("CUSTOM_BASE_URL is not set: fill in your provider's address (up to /v1) first");
  const apiKey = env.CUSTOM_API_KEY?.trim() ?? "";
  const model = id.slice(CUSTOM_PREFIX.length);
  if (env.CUSTOM_FORMAT?.trim().toLowerCase() === "anthropic") return createAnthropic({ baseURL, apiKey, fetch: withoutOldThinking })(model);
  return createOpenAI({ baseURL, apiKey, name: "custom" }).chat(model);
}
