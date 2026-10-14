// Adapted from https://github.com/sakisakisa-design/web-fetch (src/lib/compress.ts at 65e7d4e): the same
// policy, token estimate, chunking and prompts. The model is any one the resident can talk to (WEB_FETCH_MODEL:
// a Workers AI id, or a vendor model such as anthropic/… or openai/… through AI Gateway).
// MIT License, Copyright (c) 2026 Claude World.
//
// A long page handed to the resident whole would sit in the conversation until the next handoff letter,
// so before it reaches the model it is shrunk by a small, cheap model:
//
//   | page size            | with query | without query |
//   |----------------------|------------|---------------|
//   | < QUERY_MIN tokens   | raw        | raw           |
//   | < THRESHOLD tokens   | extracted  | raw           |
//   | >= THRESHOLD tokens  | extracted  | condensed     |
//
// Compression never fails a read: if the model errors, times out or is off, the page comes back as it was.

import { generateText, type LanguageModel } from "ai";

const THRESHOLD_TOKENS = 8_000;
const QUERY_MIN_TOKENS = 800;
/** Tokens of page text handed to the model per call. */
const CHUNK_TOKENS = 6_000;
/** Upper bound on chunks, so one huge page can't fan out into many model calls. */
const MAX_CHUNKS = 6;
const CONCURRENCY = 3;
const MAX_OUTPUT_TOKENS = 1_500;
// Two rounds of three calls at most, so a long page is done well inside web_fetch's time.
const CALL_TIMEOUT_MS = 20_000;

export const DEFAULT_COMPRESS_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/** The model that shrinks pages, and its id as it was configured. */
export type Compressor = { name: string; model: LanguageModel };

export type Compressed = { content: string; note?: string };

/**
 * Rough token estimate: Latin text runs about 4 characters per token, CJK about 1,
 * so Chinese pages are not underestimated 4x.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    }
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Split text into chunks of about `chunkTokens`, breaking at headings, then blank lines, then lines. */
export function chunkText(text: string, chunkTokens = CHUNK_TOKENS): string[] {
  if (estimateTokens(text) <= chunkTokens) return [text];
  const chunks: string[] = [];
  let current = "";
  let currentTokens = 0;
  for (const block of text.split(/\n(?=#{1,6}\s)|\n{2,}/)) {
    const blockTokens = estimateTokens(block);
    if (blockTokens > chunkTokens) {
      if (current) chunks.push(current);
      current = "";
      currentTokens = 0;
      chunks.push(...hardSplit(block, chunkTokens));
      continue;
    }
    if (currentTokens + blockTokens > chunkTokens && current) {
      chunks.push(current);
      current = block;
      currentTokens = blockTokens;
    } else {
      current = current ? `${current}\n\n${block}` : block;
      currentTokens += blockTokens;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function hardSplit(block: string, chunkTokens: number): string[] {
  const out: string[] = [];
  let current = "";
  let currentTokens = 0;
  const push = () => {
    if (current) out.push(current);
    current = "";
    currentTokens = 0;
  };
  for (const line of block.split("\n")) {
    const lineTokens = estimateTokens(line);
    if (lineTokens > chunkTokens) {
      push();
      out.push(...sliceByTokens(line, chunkTokens));
      continue;
    }
    if (currentTokens + lineTokens > chunkTokens && current) push();
    current = current ? `${current}\n${line}` : line;
    currentTokens += lineTokens;
  }
  push();
  return out;
}

function sliceByTokens(line: string, chunkTokens: number): string[] {
  const charsPerToken = Math.max(1, line.length / Math.max(1, estimateTokens(line)));
  const sliceChars = Math.max(1, Math.floor(chunkTokens * charsPerToken));
  const pieces: string[] = [];
  for (let i = 0; i < line.length; i += sliceChars) pieces.push(line.slice(i, i + sliceChars));
  return pieces;
}

const EXTRACT_SYSTEM = [
  "You extract the parts of a web page that answer a specific question.",
  "",
  "Rules:",
  "- Copy relevant passages VERBATIM, in the page's own language. Do not paraphrase facts, numbers, prices, versions, dates, or identifiers.",
  "- Reproduce code blocks, commands, tables and links exactly as written, keeping markdown fences.",
  "- Keep the markdown heading each passage came from, so the caller knows where it sits in the page.",
  "- Omit navigation, boilerplate, ads, cookie notices and anything unrelated to the question.",
  "- If this section of the page contains nothing relevant, reply with exactly: NOTHING_RELEVANT",
  "- Output only the extracted markdown. No preamble, no commentary, no meta-explanation."
].join("\n");

const CONDENSE_SYSTEM = [
  "You condense a web page into a compact briefing for another AI agent.",
  "",
  "Rules:",
  "- Write in the page's own language and preserve its heading structure.",
  "- Keep all concrete facts verbatim: numbers, prices, versions, dates, names, identifiers.",
  "- Reproduce code blocks, commands and API signatures exactly, keeping markdown fences.",
  "- Keep links that a reader would need to follow, in markdown link syntax.",
  "- Drop navigation, boilerplate, ads, cookie notices, repeated marketing copy.",
  "- Aim for roughly a quarter of the original length, shorter if the page is mostly filler.",
  "- Output only the condensed markdown. No preamble, no commentary."
].join("\n");

const NOTHING_RELEVANT = "NOTHING_RELEVANT";

/** The model's "nothing here" answer, give or take punctuation; a passage that merely mentions it is kept. */
function isNothing(text: string): boolean {
  return text.replace(/[\s.。*`"'-]/g, "") === NOTHING_RELEVANT;
}

/** Shrink a page when the policy above says so. Always resolves. */
export async function compressPage(
  compressor: Compressor | null,
  content: string,
  query?: string,
  signal?: AbortSignal
): Promise<Compressed> {
  const question = query?.trim() || undefined;
  if (!content.trim()) return { content };
  const tokens = estimateTokens(content);
  if (!(question ? tokens > QUERY_MIN_TOKENS : tokens > THRESHOLD_TOKENS)) return { content };
  if (!compressor) return { content };

  let chunks = chunkText(content);
  const cut = chunks.length > MAX_CHUNKS;
  if (cut) chunks = chunks.slice(0, MAX_CHUNKS);
  const system = question ? EXTRACT_SYSTEM : CONDENSE_SYSTEM;

  const results: ({ ok: true; text: string } | { ok: false; error: string })[] = [];
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY).map(async (chunk, offset) => {
      const position = chunks.length > 1 ? `Section ${i + offset + 1} of ${chunks.length}.\n\n` : "";
      const user = question ? `Question: ${question}\n\n${position}Page content:\n\n${chunk}` : `${position}Page content:\n\n${chunk}`;
      try {
        return { ok: true as const, text: await chat(compressor, system, user, signal) };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    });
    results.push(...(await Promise.all(batch)));
    // web_fetch gave up: stop calling the model for an answer nobody will read.
    if (signal?.aborted) return { content, note: "could not be shortened in time, so here is the page as it is" };
  }

  if (results.every((result) => !result.ok)) {
    const first = results.find((result) => !result.ok);
    console.error("web_fetch: compression failed", { error: first && !first.ok ? first.error : "" });
    return { content, note: "could not be shortened, so here is the page as it is" };
  }
  const failed = results.filter((result) => !result.ok).length;
  const kept = results
    .flatMap((result) => (result.ok ? [result.text.trim()] : []))
    .filter((text) => text && !isNothing(text));
  if (!kept.length) {
    return question
      ? { content: `Nothing on this page seems to be about: ${question}`, note: "read without a query to see the whole page" }
      : { content, note: "could not be shortened, so here is the page as it is" };
  }
  const notes = [question ? `only the parts about: ${question}` : "a condensed version of a long page"];
  if (failed) notes.push(`${failed} of ${results.length} sections could not be read`);
  if (cut) notes.push(`only the first ${MAX_CHUNKS} sections of a very long page were read`);
  return { content: kept.join("\n\n"), note: notes.join("; ") };
}

async function chat(compressor: Compressor, system: string, user: string, signal?: AbortSignal): Promise<string> {
  // Qwen3 thinks before answering unless told not to; extraction needs no thinking.
  const prompt = compressor.name.toLowerCase().includes("qwen3") ? `${system}\n\n/no_think` : system;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const run = generateText({
    model: compressor.model,
    system: prompt,
    prompt: user,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    abortSignal: stop
  }).then((result) => result.text);
  // The call is cancelled through the signal; the race is for a provider that does not honour it.
  const stopped = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(timeout.aborted ? `no answer in ${CALL_TIMEOUT_MS / 1000}s` : "stopped"));
    if (stop.aborted) fail();
    else stop.addEventListener("abort", fail, { once: true });
  });
  return clean(await Promise.race([run, stopped]));
}

/** The answer without a think block. Throws when nothing is left. */
function clean(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) throw new Error("the model returned no text");
  return text;
}
