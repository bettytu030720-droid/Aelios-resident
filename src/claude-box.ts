// The Claude box's Durable Object: it starts the container (claude-box/, deployed by `npm run deploy:claude`) when
// a turn needs it, waits for it to listen, and passes the turn on. The container stops itself after a while without
// turns and starts again on the next one; it keeps nothing, so nothing is lost when it does (claude-code.ts).
// Deployed without the container (`npm run deploy`, the free plan), the class is still here but has no container,
// and a turn is told how to deploy it.

import { DurableObject } from "cloudflare:workers";

const PORT = 8080;
// The image `npm run deploy:claude` builds (scripts/deploy-claude.mjs): this object starts it itself, since accounts
// now create Durable Object-managed containers.
const IMAGE = "box";
// Half a vCPU and 4 GiB, the smallest size these containers take that Claude Code starts in quickly: on lite
// (1/16 vCPU) one turn took about a minute.
const INSTANCE = "standard-1";
// How long the container keeps running once turns stop: a conversation's pauses, without paying for idle hours.
const IDLE_MS = 20 * 60_000;
// The first start after a deploy pulls the image; later starts take a few seconds.
const READY_MS = 120_000;

export const NO_CONTAINER = "这次部署没带 Claude 容器：用 npm run deploy:claude 部署（要 Workers Paid）";

export class ClaudeBox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The timeout is the runtime's, not this object's: set it again whenever the object wakes.
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(IDLE_MS).catch(() => {}));
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    const image = container?.images?.[IMAGE];
    if (!container || !image) return Response.json({ error: NO_CONTAINER }, { status: 501 });
    try {
      await this.ready(container, image);
    } catch (error) {
      return Response.json({ error: `Claude 容器没起来：${error instanceof Error ? error.message : String(error)}` }, { status: 503 });
    }
    // The container's answer goes back as it comes, not read here: when the resident cancels the call (stopped,
    // stalled, aborted), that cancels this stream, the connection to the container closes, and the box stops
    // Claude Code. request.signal would need the enable_request_signal flag for the whole Worker.
    return container.getTcpPort(PORT).fetch("http://box/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body
    });
  }

  /** Starts the container if it is not running and waits until it answers. */
  private async ready(container: Container, image: string): Promise<void> {
    // A deploy does not restart a running container: one still on the image before it is stopped and started anew
    // (an empty image means it is still starting).
    const running = container.running ? await container.inspect() : null;
    if (running?.image && running.image !== image) await container.destroy();
    const deadline = Date.now() + READY_MS;
    let last = "";
    while (Date.now() < deadline) {
      if (!container.running) {
        container.start({ image, instance: INSTANCE, enableInternet: true });
        await container.setInactivityTimeout(IDLE_MS);
      }
      try {
        const response = await container.getTcpPort(PORT).fetch("http://box/health");
        if (response.ok) return;
        last = `health ${response.status}`;
      } catch (error) {
        // Not listening yet, or still being placed.
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(last || "timed out");
  }
}
