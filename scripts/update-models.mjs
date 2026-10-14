// Refreshes public/models.json, the list the web page's model picker searches, from Cloudflare's
// public model catalog (Workers AI models and the providers AI Gateway routes to). Text generation only.
//   node scripts/update-models.mjs
// Ids missing from the list still work: the picker takes any id typed into its search box.
import { writeFile } from "node:fs/promises";

const SOURCE = "https://developers.cloudflare.com/ai/models/index.md";
const TASK = "Text Generation";

const page = await (await fetch(SOURCE)).text();
const entry = /<h3>([^<]+)<\/h3>(.*?)\]\(https:\/\/developers\.cloudflare\.com\/ai\/models\/([^)]+)\/\)\s*\n((?:\s*- [^\n]*\n)*)/gs;
const models = [];
for (const [, name, card, id, tags] of page.matchAll(entry)) {
  const text = card.trim();
  const at = text.indexOf(TASK);
  if (at < 0 || at > 40) continue;
  const provider = text.slice(0, at).replace(/^Beta/, "") || id.split("/")[id.startsWith("@") ? 1 : 0];
  const desc = text.slice(at + TASK.length).trim();
  models.push({
    id,
    name,
    provider,
    hosted: tags.includes("Cloudflare-hosted"),
    desc: desc.length > 160 ? `${desc.slice(0, 157)}...` : desc
  });
}
// The catalog spells some providers two ways ("DeepSeek", "deepseek"); keep the capitalised one.
const spelling = new Map();
for (const { provider } of models) {
  const key = provider.toLowerCase();
  if (!spelling.has(key) || provider !== key) spelling.set(key, provider);
}
for (const model of models) model.provider = spelling.get(model.provider.toLowerCase());
if (models.length < 20) throw new Error(`only ${models.length} models found; the catalog page may have changed`);
const updated = new Date().toISOString().slice(0, 10);
await writeFile(new URL("../public/models.json", import.meta.url), `${JSON.stringify({ updated, source: SOURCE, models })}\n`);
console.log(`${models.length} models, ${updated}`);
