import { audioTypeOf, SPEAK_MAX_CHARS, speakable, type Speak, type Spoken } from "../voice";

export type VoiceClip = { key: string; seconds: number | null };
export type VoicePlayback = VoiceClip & { parts?: string[]; live?: true };

export function playbackOf(clips: VoiceClip[], live = false): VoicePlayback | null {
  const first = clips[0];
  if (!first) return null;
  return {
    key: first.key,
    seconds: clips.reduce((total, clip) => total + (clip.seconds ?? 0), 0) || null,
    ...(clips.length > 1 ? { parts: clips.map(clip => clip.key) } : {}),
    ...(live ? { live: true as const } : {})
  };
}

const CONCURRENCY = 2;
const MAX_SEGMENTS = 12;
// Treat URLs, Markdown links and voice/sticker marks as units, even if a delta ended inside one.
const BOUNDARY = /\[[^\]\n]*(?:\](?:\(https?:\/\/[^\s)]*(?:\)|$))?|$)|<[^>\n]*(?:>|$)|https?:\/\/[^\s]*|([。！？!?；;…]+[”’」』）)]*|\.+(?=\s)|\n+)|([，、,]|\s+)/gu;

function splitAt(text: string, first: boolean): number {
  const minimum = first ? 16 : 55;
  const target = first ? 55 : 140;
  let soft = 0;
  for (const match of text.matchAll(BOUNDARY)) {
    const end = match.index + match[0].length;
    if (match[1] && end >= minimum) return end;
    if (match[2] && end >= minimum) soft = end;
    if (end >= target && soft) return soft;
  }
  return text.length >= target ? soft : 0;
}

type Host = {
  speak: Speak;
  maxBytes: number;
  keep: (spoken: Spoken) => string | null;
  release: (key: string) => void;
  changed: () => void;
  waitUntil: (work: Promise<void>) => void;
};

type Segment = { text: string; clip?: VoiceClip };

/** One web reply. Synthesis can finish out of order, but only the contiguous prefix is playable. */
export class ReplyVoice {
  private readonly abort = new AbortController();
  private readonly segments: Segment[] = [];
  private tail = "";
  private chars = 0;
  private bytes = 0;
  private started = 0;
  private running = 0;
  private closed = false;
  private inputFull = false;
  private error: unknown;
  private settle!: () => void;
  private readonly done = new Promise<void>(resolve => { this.settle = resolve; });

  constructor(private readonly host: Host) {}

  push(delta: string): void {
    if (this.closed || this.inputFull || this.abort.signal.aborted) return;
    this.tail += delta;
    if (this.tail.length > SPEAK_MAX_CHARS * 4) {
      // Keep the playable prefix and reconcile the unsaid tail against the stored reply once it is complete.
      this.tail = "";
      this.inputFull = true;
    } else {
      this.segment(false);
    }
    this.pump();
  }

  live(): VoicePlayback | null {
    if (this.abort.signal.aborted) return null;
    const clips: VoiceClip[] = [];
    for (const segment of this.segments) {
      if (!segment.clip) break;
      clips.push(segment.clip);
    }
    return playbackOf(clips, true);
  }

  async finish(reply: string): Promise<VoiceClip[] | null> {
    if (!this.abort.signal.aborted) {
      const final = speakable(reply);
      const spoken = this.segments.map(segment => segment.text).join("").replace(/\s+/g, "");
      if (!final || !final.replace(/\s+/g, "").startsWith(spoken)) {
        this.cancel();
      } else {
        // The stored reply can trim text after tools. Only synthesize what follows the already queued prefix.
        let offset = 0;
        for (let length = 0; length < spoken.length; offset++) {
          if (!/\s/.test(final[offset])) length++;
        }
        this.tail = final.slice(offset);
        this.segment(true);
      }
    }
    this.closed = true;
    this.pump();
    await this.done;
    if (this.error) throw this.error;
    return this.abort.signal.aborted ? null : this.segments.flatMap(segment => segment.clip ?? []);
  }

  cancel(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    for (const { clip } of this.segments) if (clip) this.host.release(clip.key);
    this.host.changed();
    if (!this.running) this.settle();
  }

  private segment(flush: boolean): void {
    while (this.tail) {
      const at = this.segments.length < MAX_SEGMENTS - 1 ? splitAt(this.tail, !this.segments.length) : 0;
      if (!at && !flush) break;
      const text = speakable(this.tail.slice(0, at || this.tail.length));
      this.tail = this.tail.slice(at || this.tail.length);
      if (!text) continue;
      const remaining = SPEAK_MAX_CHARS - this.chars;
      const bounded = text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
      if (bounded) {
        this.chars += bounded.length;
        this.segments.push({ text: bounded });
      }
      if (text.length >= remaining) {
        this.tail = "";
        this.inputFull = true;
        return;
      }
    }
  }

  private pump(): void {
    while (!this.abort.signal.aborted && this.running < CONCURRENCY && this.started < this.segments.length) {
      const segment = this.segments[this.started++];
      this.running++;
      this.host.waitUntil(this.make(segment));
    }
    if (!this.running && (this.closed || this.abort.signal.aborted)) this.settle();
  }

  private async make(segment: Segment): Promise<void> {
    try {
      const audio = await this.host.speak(segment.text, { signal: this.abort.signal });
      if (this.abort.signal.aborted) return;
      if (audioTypeOf(audio.audio) !== "audio/mpeg") throw new Error("the voice provider returned audio in a format other than MP3");
      this.bytes += audio.audio.length;
      if (this.bytes > this.host.maxBytes) throw new Error("the spoken reply is too large");
      const key = this.host.keep(audio);
      if (!key) throw new Error("could not store a voice segment");
      segment.clip = { key, seconds: audio.seconds || null };
      this.host.changed();
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.error = error;
        this.cancel();
      }
    } finally {
      this.running--;
      this.pump();
    }
  }
}
