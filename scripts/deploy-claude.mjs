// `npm run deploy:claude`: deploys the resident with the Claude box's container (claude-box/), for the
// claude-code/… models on your own Claude subscription. Containers need Workers Paid, so plain `npm run deploy`
// leaves it out and the free plan keeps working. This writes wrangler.claude.jsonc (wrangler.jsonc plus the
// container; not tracked) next to it and deploys that. Docker, or Workers Builds, builds the image.
// Usage: npm run deploy:claude [-- other wrangler deploy flags]

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** JSON with comments and trailing commas (wrangler.jsonc) as plain JSON. */
export function plainJson(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else {
      out += c;
    }
  }
  return out;
}

export function withClaudeBox(config) {
  return {
    ...config,
    containers: [
      {
        class_name: "ClaudeBox",
        // Accounts now create containers whose Durable Object picks the image and size when it starts one
        // (src/claude-box.ts); there is only ever the one, named "default".
        scheduling_policy: "durable_object",
        images: { box: { dockerfile: "./claude-box/Dockerfile" } }
      }
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Comments and trailing commas are dropped (JSON parses the rest) before the container is added.
  const config = JSON.parse(plainJson(readFileSync("wrangler.jsonc", "utf8")));
  writeFileSync("wrangler.claude.jsonc", `// Written by scripts/deploy-claude.mjs from wrangler.jsonc; change that file instead.\n${JSON.stringify(withClaudeBox(config), null, 2)}\n`);
  const result = spawnSync("npx", ["wrangler", "deploy", "--config", "wrangler.claude.jsonc", ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
