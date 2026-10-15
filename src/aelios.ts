// Aelios as long-term memory. The chat itself goes out through Aelios' model endpoint (via-aelios.ts), where
// Aelios recalls for her message and records the exchange. Besides that:
//   POST /v1/memory/recall   the memory_recall tool
//   POST /v1/memory/ingest   handoff letters and check-ins, which Aelios does not record as conversation
//   GET  /v1/memory_boot     yesterday's diary, precious notes and glossary, added to the system prompt
//   POST /mcp                remember, keep a moment, forget, learn a word, read the diary: Aelios' own MCP
//                            tools, wrapped here with short descriptions so they cost few tokens per turn
// Unset AELIOS_URL or AELIOS_API_KEY and all of it quietly does nothing.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { callMcpTool } from "./mcp";

export type AeliosConfig = {
  url: string;
  key: string;
  namespace: string;
  /** The identity set up in Aelios' admin page that the chat goes out as; "" for the key's first one. */
  identity: string;
};

const BOOT_MAX_CHARS = 3000;

export function aeliosConfig(env: Env): AeliosConfig | null {
  const url = env.AELIOS_URL?.trim().replace(/\/+$/, "");
  const key = env.AELIOS_API_KEY?.trim();
  if (!url || !key) return null;
  return {
    url,
    key,
    namespace: env.AELIOS_NAMESPACE?.trim() || "default",
    identity: env.AELIOS_IDENTITY?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  };
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

export type RecallHit = { id?: string; content: string; type?: string; score?: number };

/** Search Aelios' long-term memory. Throws when Aelios cannot be reached or answers with an error. */
export async function recall(config: AeliosConfig, query: string, k: number, signal?: AbortSignal): Promise<RecallHit[]> {
  const response = await aelios(config, "/v1/memory/recall", {
    method: "POST",
    body: JSON.stringify({ query, namespace: config.namespace, k }),
    signal
  });
  if (!response.ok) throw new Error(`memory unavailable (${response.status})`);
  const body = (await response.json()) as { data?: Partial<RecallHit>[] };
  return (body.data ?? []).filter((hit): hit is RecallHit => typeof hit.content === "string" && hit.content.trim() !== "");
}

const MCP_RESULT_MAX_CHARS = 4000;

/** The memory tools the model gets: recall over REST, the rest through Aelios' MCP. */
export function memoryTools(config: AeliosConfig): ToolSet {
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    try {
      const text = await callMcpTool(`${config.url}/mcp`, config.key, name, { ...args, namespace: config.namespace });
      return text.length > MCP_RESULT_MAX_CHARS ? `${text.slice(0, MCP_RESULT_MAX_CHARS)}…` : text;
    } catch (error) {
      return `memory unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    memory_recall: tool({
      description: "Search long-term memory for something from before. Each hit starts with its [id].",
      inputSchema: z.object({ query: z.string().describe("What to look for, in a few words.") }),
      async execute({ query }) {
        let hits: RecallHit[];
        try {
          hits = await recall(config, query, 5);
        } catch (error) {
          return error instanceof Error ? error.message : "memory unavailable";
        }
        return hits.length ? hits.map((hit) => `- [${hit.id ?? "?"}] ${hit.content}`).join("\n") : "No matching memory.";
      }
    }),
    memory_remember: tool({
      description:
        "Save one self-contained sentence worth keeping: a fact about her, a plan, a promise, a correction. " +
        "To update a memory, pass its id as replaces.",
      inputSchema: z.object({
        content: z.string(),
        replaces: z.string().optional().describe("Id of the memory this one updates.")
      }),
      execute: ({ content, replaces }) => call("remember", { content, ...(replaces ? { replaces } : {}) })
    }),
    memory_keep_moment: tool({
      description: "Keep a moment she will want to look back on, in her words.",
      inputSchema: z.object({ content: z.string() }),
      execute: ({ content }) => call("keep_moment", { content })
    }),
    memory_forget: tool({
      description: "Archive a memory that is wrong or that she wants gone, by id. It can be brought back in Aelios.",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => call("forget", { id })
    }),
    memory_learn_word: tool({
      description: "Learn a private word, nickname or in-joke between you two.",
      inputSchema: z.object({ term: z.string(), definition: z.string() }),
      execute: ({ term, definition }) => call("learn_word", { term, definition })
    }),
    memory_read_diary: tool({
      description: "Read the diary of a day (YYYY-MM-DD) or a week (like 2026-W42).",
      inputSchema: z.object({ date: z.string().optional(), week: z.string().optional() }),
      execute: ({ date, week }) => call("read_diary", { ...(date ? { date } : {}), ...(week ? { week } : {}) })
    })
  };
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
