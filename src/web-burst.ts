// Messages she sends on the web page (the desktop app posts to the same route) within a few seconds of each other are
// answered as one turn, as on Telegram (the messenger's "burst", DEBOUNCE_SECONDS). Each message is still its own
// line in the conversation. A message sent while a reply is being written waits for the next turn, with any others
// sent in the meantime, instead of starting a turn of its own.
import type { UIMessage } from "ai";

export type BurstResult = { status: string };
/** Runs one turn. `take` hands over the messages when the turn starts, and closes the burst they came in. */
export type BurstRun = (take: () => UIMessage[]) => Promise<BurstResult>;

type Burst = {
  messages: UIMessage[];
  /** Waiting for a quiet moment; null once the burst is sent and waits for its turn to start. */
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
  done: Promise<BurstResult>;
  settle: (turn: Promise<BurstResult>) => void;
};

export class WebBurst {
  #open: Burst | null = null;

  constructor(private readonly run: BurstRun, private readonly waitMs: () => number) {}

  /** Messages of hers are waiting for their turn to start. */
  get waiting(): boolean {
    return this.#open !== null;
  }

  /**
   * Adds her message; resolves with the turn that answers it, together with the others of its burst. `waitMs` stands
   * in for the usual quiet time (0 on a call, where the page has already waited for her to stop talking).
   */
  add(message: UIMessage, waitMs?: number): Promise<BurstResult> {
    let burst = this.#open;
    if (!burst) {
      let settle!: Burst["settle"];
      const done = new Promise<BurstResult>((resolve) => (settle = resolve));
      burst = this.#open = { messages: [], timer: null, sent: false, done, settle };
    }
    burst.messages.push(message);
    // Not sent yet: each new message waits the quiet time again. Once sent, the burst waits for its turn to start.
    if (!burst.sent) {
      if (burst.timer) clearTimeout(burst.timer);
      const waiting = burst;
      burst.timer = setTimeout(() => this.#send(waiting), Math.max(0, waitMs ?? this.waitMs()));
    }
    return burst.done;
  }

  #send(burst: Burst): void {
    burst.timer = null;
    burst.sent = true;
    const take = () => {
      if (this.#open === burst) this.#open = null;
      return [...burst.messages];
    };
    burst.settle(
      this.run(take).finally(() => {
        // A turn that never started (the conversation was reset) took nothing: what comes later starts afresh.
        if (this.#open === burst) this.#open = null;
      })
    );
  }
}
