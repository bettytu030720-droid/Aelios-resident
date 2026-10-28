// What is left of the Claude box's Durable Object. The box used to run in a Cloudflare container started from here;
// it now runs on a machine of the owner's (claude-box/, docs/claude-box.md), reached at the address on the settings
// page. The class stays because earlier deploys made it (migration v2): it keeps nothing and answers nothing.

import { DurableObject } from "cloudflare:workers";

export class ClaudeBox extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return Response.json({ error: "The Claude box no longer runs here: see docs/claude-box.md" }, { status: 410 });
  }
}
