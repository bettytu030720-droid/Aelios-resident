// Aelios as long-term memory, over its REST API:
//   POST /v1/memory/recall   the memory_recall tool
//   POST /v1/memory/ingest   every exchange and every handoff letter, so Dream can digest them at night
//   GET  /v1/memory_boot     yesterday's diary, precious notes and glossary, added to the system prompt
// Unset AELIOS_URL or AELIOS_API_KEY and all three quietly do nothing.

import { tool } from "ai";
import { z } from "zod";

export type AeliosConfig = {
  url: string;
  key: string;
  namespace: string;
};

const BOOT_MAX_CHARS = 3000;

export function aeliosConfig(env: Env): AeliosConfig | null {
  const url = env.AELIOS_URL?.trim().replace(/\/+$/, "");
  const key = env.AELIOS_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key, namespace: env.AELIOS_NAMESPACE?.trim() || "default" };
}

async function aelios(config: AeliosConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
      ...init.headers
    }
  });
}

type RecallHit = { content?: string; type?: string; score?: number };

export function recallTool(config: AeliosConfig) {
  return tool({
    description:
      "Search your long-term memory (Aelios) for things the two of you said or decided before: facts about her, " +
      "promises, past events, names. Use it when she refers to something earlier that is not in this conversation. " +
      "Query in the language the memory was said in.",
    inputSchema: z.object({
      query: z.string().describe("What to look for, in a few words.")
    }),
    async execute({ query }) {
      const response = await aelios(config, "/v1/memory/recall", {
        method: "POST",
        body: JSON.stringify({ query, namespace: config.namespace, k: 5 })
      });
      if (!response.ok) return `memory unavailable (${response.status})`;
      const body = (await response.json()) as { data?: RecallHit[] };
      const hits = (body.data ?? []).filter((hit) => hit.content);
      return hits.length ? hits.map((hit, i) => `${i + 1}. ${hit.content}`).join("\n") : "No matching memory.";
    }
  });
}

export type IngestMessage = { role: "user" | "assistant"; content: string };

/** Record messages in Aelios. Failures are logged; the chat never waits on memory. */
export async function ingest(config: AeliosConfig, messages: IngestMessage[], source: string): Promise<void> {
  try {
    const response = await aelios(config, "/v1/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        namespace: config.namespace,
        conversation_id: `${config.namespace}:aelios-resident`,
        source,
        messages
      })
    });
    if (!response.ok) console.error("aelios: ingest failed", { status: response.status });
  } catch (error) {
    console.error("aelios: ingest failed", { error: String(error) });
  }
}

type BootData = {
  daily_log?: { title?: string; summary?: string } | null;
  precious?: { content?: string }[];
  glossary?: { term?: string; definition?: string }[];
};

/** A compact text of Aelios' boot packet, or "" when there is none. */
export async function fetchBoot(config: AeliosConfig): Promise<string> {
  try {
    const response = await aelios(config, `/v1/memory_boot?namespace=${encodeURIComponent(config.namespace)}`);
    if (!response.ok) return "";
    const { data } = (await response.json()) as { data?: BootData };
    if (!data) return "";
    const parts: string[] = [];
    if (data.daily_log?.summary) parts.push(`昨天：${data.daily_log.summary}`);
    const precious = (data.precious ?? []).map((p) => p.content).filter(Boolean);
    if (precious.length) parts.push(`珍贵的原话：\n${precious.map((p) => `- ${p}`).join("\n")}`);
    const glossary = (data.glossary ?? []).filter((g) => g.term);
    if (glossary.length) parts.push(`我们的黑话：\n${glossary.map((g) => `- ${g.term}：${g.definition ?? ""}`).join("\n")}`);
    const text = parts.join("\n\n");
    return text.length > BOOT_MAX_CHARS ? `${text.slice(0, BOOT_MAX_CHARS)}…` : text;
  } catch (error) {
    console.error("aelios: boot failed", { error: String(error) });
    return "";
  }
}

/** Keep a line as a precious memory, the same as the heart in Aelios' admin page. */
export async function pin(config: AeliosConfig, content: string): Promise<boolean> {
  const response = await aelios(config, "/v1/precious", {
    method: "POST",
    body: JSON.stringify({ namespace: config.namespace, content, source: "human" })
  });
  return response.ok;
}
