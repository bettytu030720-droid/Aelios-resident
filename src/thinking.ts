// How Claude thinks, on the routes that speak Anthropic's Messages API (through Aelios, or a provider of your
// own in the anthropic format). Set in the request body just before it goes out, from the model name in it:
//   display  Claude Opus/Sonnet/Haiku 5 and later, Fable and Mythos think on every turn but send the thinking
//            back empty unless asked; "summarized" sends a readable summary, which the web page folds under
//            「想了一下」. Thinking costs the same either way.
//   effort   THINKING_EFFORT (low … max) as output_config.effort, on the models that take it; "auto" (the
//            default) sends none, so each model thinks as much as its own default (Opus 5.5 medium, Sonnet 5.5
//            high). Changing it rewrites the conversation's cache once.
// Older Claude models are left as they are: they think only when asked, and some take no effort at all.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** THINKING_EFFORT as a level, or null for "auto" (the model's own default). */
export function effortOf(setting: string | undefined): Effort | null {
  const value = setting?.trim().toLowerCase();
  return EFFORTS.find((effort) => effort === value) ?? null;
}

type Claude = { family: string; version: number };

/** claude-opus-5-5, anthropic/claude-sonnet-4.5, claude-haiku-4-5-20251001 → family and version; null otherwise. */
export function claudeOf(name: string): Claude | null {
  const match = name.toLowerCase().match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d{1,2}))?(?!\d)/);
  if (!match) return null;
  return { family: match[1], version: Number(match[2]) + Number(match[3] ?? 0) / 10 };
}

/** Thinks on every turn without being asked, and hides the thinking unless display says otherwise. */
function thinksByDefault({ family, version }: Claude): boolean {
  return family === "fable" || family === "mythos" || version >= 5;
}

function takesEffort({ family, version }: Claude): boolean {
  if (family === "fable" || family === "mythos") return true;
  if (family === "opus") return version >= 4.5;
  if (family === "sonnet") return version >= 4.6;
  return version >= 5;
}

/** The Messages request with Claude's thinking shown and THINKING_EFFORT applied, where the model takes them. */
export function withThinking(body: Record<string, unknown>, effort: Effort | null): Record<string, unknown> {
  const claude = typeof body.model === "string" ? claudeOf(body.model) : null;
  if (!claude) return body;
  const out = { ...body };
  const thinking = (out.thinking ?? undefined) as Record<string, unknown> | undefined;
  if (thinksByDefault(claude) && (!thinking || (thinking.type === "adaptive" && thinking.display === undefined))) {
    out.thinking = { type: "adaptive", ...thinking, display: "summarized" };
  }
  if (effort && takesEffort(claude)) out.output_config = { ...(out.output_config as object | undefined), effort };
  return out;
}
