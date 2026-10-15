// With Aelios connected, the chat goes out through Aelios' own model endpoint (https://<Aelios>/<identity>/v1),
// as any chat app pointed at Aelios does. Aelios recalls what fits her message and adds it to that request,
// records the exchange for Dream, and calls the model with the providers and keys set up there.
//   anthropic/…   the Messages API, so Claude's prompt cache works: Aelios puts the cache marker on her message
//                 and its recall after it, so the earlier turns are still read from the cache
//   anything else chat completions, under the name Aelios gives it (a Workers AI id goes under workers-ai/)
// The system's own notes (the handoff letter, a check-in) and the trial call when a model is picked are marked
// auxiliary: Aelios neither recalls for them nor records them as something she said.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AeliosConfig } from "./aelios";
import { withoutOldThinkingIn } from "./claude-run";
import { isNote } from "./prompts";

export const PURPOSE_HEADER = "x-aelios-purpose";
/** For a call that is not part of the conversation: Aelios passes it on without recalling or recording. */
export const AUXILIARY = { [PURPOSE_HEADER]: "auxiliary" };
/** Aelios says here whether it handled memory: "off" when the model is not one of the identity's main models. */
export const MEMORY_HEADER = "x-aelios-memory";

/** The model name as Aelios takes it. */
export function aeliosName(id: string): string {
  return id.startsWith("@cf/") ? `workers-ai/${id}` : id;
}

/** Whether Aelios gets this model on the Messages API. */
export function onMessages(id: string): boolean {
  return aeliosName(id).toLowerCase().startsWith("anthropic/");
}

export function aeliosBase(memory: AeliosConfig): string {
  return `${memory.url}${memory.identity ? `/${encodeURIComponent(memory.identity)}` : ""}/v1`;
}

type Message = { role?: unknown; content?: unknown };

/** The text of the last message that was said rather than a tool result: hers, or one of the system's notes. */
export function lastSaid(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i] ?? {};
    if (role !== "user") continue;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string")
      .map((part: { text: string }) => part.text)
      .join("\n");
    if (text) return text;
  }
  return "";
}

/** Whether a request to Aelios should be marked auxiliary: the turn answers one of the system's notes. */
export function isAuxiliary(body: Record<string, unknown>): boolean {
  return isNote(lastSaid(body).trimStart());
}

/** Told what Aelios did about memory on each of her turns (MEMORY_HEADER), so "off" can be shown to her. */
export type MemoryReport = (status: string) => void;

function sender(messages: boolean, auxiliary: boolean, report?: MemoryReport): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") return fetch(input, init);
    let body = JSON.parse(init.body) as Record<string, unknown>;
    const headers = new Headers(init.headers);
    const hers = !auxiliary && !isAuxiliary(body);
    if (!hers) headers.set(PURPOSE_HEADER, "auxiliary");
    // Claude's earlier thinking goes back without its blocks, for the reason in claude-run.ts.
    if (messages) body = withoutOldThinkingIn(body);
    const response = await fetch(input, { ...init, headers, body: JSON.stringify(body) });
    const status = response.headers.get(MEMORY_HEADER);
    if (hers && status && report) report(status);
    return response;
  };
}

/**
 * A model id as a model that goes out through Aelios. `auxiliary` marks every call, for work outside the
 * conversation (shrinking a web page, the trial call); otherwise only turns that answer a system note are marked.
 */
export function aeliosModel(
  memory: AeliosConfig,
  id: string,
  { auxiliary = false, report }: { auxiliary?: boolean; report?: MemoryReport } = {}
): LanguageModel {
  const name = aeliosName(id);
  const baseURL = aeliosBase(memory);
  if (onMessages(id)) return createAnthropic({ baseURL, apiKey: memory.key, fetch: sender(true, auxiliary, report) })(name);
  return createOpenAI({ baseURL, apiKey: memory.key, name: "aelios", fetch: sender(false, auxiliary, report) }).chat(name);
}
