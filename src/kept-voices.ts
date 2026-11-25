// Voice messages she keeps (语音收藏 on the web page): hers or the resident's, a call's included. A kept voice is never
// pruned and does not count towards the media store's limit (media-store.ts). With an R2 bucket bound as KEPT_VOICES,
// its audio moves there and leaves the Durable Object's SQLite; without one, it stays where it is, only marked kept.
// Kept no more, it comes back into SQLite (from the bucket, if it went there) and is pruned like any other.

import type { KeptVoice, MediaFile, MediaStore } from "./media-store";

/** A kept voice's memory while a write of it to Aelios has had no answer: it may have gone in (look before writing). */
export const MEMORY_UNSURE = "?";

/** The part of an R2 bucket used here. */
export type KeptBucket = Pick<R2Bucket, "put" | "get" | "delete" | "list">;

/**
 * Where a kept voice's file goes in the bucket: residents on one Worker share it, each under its own id. The name is
 * new each time the file goes, so a late delete of an earlier copy (let go on one device, kept again on another)
 * never takes the copy that is there now.
 */
export function keptObjectKey(resident: string, key: string): string {
  return `${keptPrefix(resident)}${key}-${crypto.randomUUID().slice(0, 8)}`;
}

export function keptPrefix(resident: string): string {
  return `voices/${resident}/`;
}

export class KeptVoices {
  /**
   * Keeping, letting go, clearing and forgetting take turns (run), so two devices at once end the way the last one
   * asked, and nothing is still being written to the bucket while the resident's files there are deleted.
   */
  #turn: Promise<unknown> = Promise.resolve();
  /** The resident is being deleted: nothing more is kept. */
  #closed = false;

  constructor(
    private readonly media: MediaStore,
    private readonly bucket: KeptBucket | null,
    private readonly resident: string
  ) {}

  /** Runs `work` in its turn, after everything asked before it. Inside, use keepNow and unkeepNow. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#turn.then(work, work);
    this.#turn = done.catch(() => {});
    return done;
  }

  /** The resident is being deleted, so nothing can be kept. */
  get closing(): boolean {
    return this.#closed;
  }

  /** Keeps a voice; with a bucket, its files move there. False when its audio is no longer all here. */
  keep(voice: Omit<KeptVoice, "keptAt" | "memory">): Promise<boolean> {
    return this.run(() => this.keepNow(voice));
  }

  /** keep, in a turn already (run). */
  async keepNow(voice: Omit<KeptVoice, "keptAt" | "memory">): Promise<boolean> {
    if (this.#closed || !this.media.keep(voice)) return false;
    if (this.bucket) for (const key of voice.keys) await this.moveAway(this.bucket, key);
    // Any copy still to clear from before (a delete that failed) is tried again, whatever it was; this keep stands either way.
    await this.flush();
    return true;
  }

  private async moveAway(bucket: KeptBucket, key: string): Promise<void> {
    if (this.media.isAway(key)) return;
    const file = this.media.get(key);
    if (!file) return;
    const object = keptObjectKey(this.resident, key);
    // Written down first, so a copy made and then lost track of (an error, an eviction) is still cleared later.
    this.media.copying(object);
    try {
      await bucket.put(object, file.bytes, { httpMetadata: { contentType: file.type } });
    } catch (error) {
      // It stays in SQLite, kept all the same.
      console.error("kept voices: could not move a voice to R2", { error: String(error) });
      await this.flush();
      return;
    }
    // Let go, removed or sent already while it was being written: it stays as it is, and this copy is cleared.
    if (!this.media.sendAway(key, object)) await this.flush();
  }

  /**
   * Clears the copies in the bucket no file points to (MediaStore.toClear). One is crossed off only once deleting it
   * worked; one that failed stays, to be tried again (the next keep, letting go, cleared file, or forgetAll).
   */
  private async flush(): Promise<void> {
    if (!this.bucket) return;
    for (const object of this.media.toClear()) {
      try {
        await this.bucket.delete(object);
        this.media.cleared(object);
      } catch (error) {
        console.error("kept voices: could not clear a voice from R2, will try again", { error: String(error) });
      }
    }
  }

  /**
   * A voice kept no more. Its files come back from the bucket first, so nothing is lost: a file the bucket no
   * longer has is removed. Then the store is pruned as usual, which may take the oldest of them at once.
   */
  unkeep(message: string): Promise<{ ok: true } | { error: string }> {
    return this.run(() => this.unkeepNow(message));
  }

  /** unkeep, in a turn already (run). */
  async unkeepNow(message: string): Promise<{ ok: true } | { error: string }> {
    const voice = this.media.kept(message);
    if (!voice) {
      // Let go already (asked again, say, after it failed to clear): still, what is left to clear is tried again.
      await this.flush();
      return { ok: true };
    }
    const away = voice.keys.flatMap((key) => {
      const object = this.media.awayTo(key);
      return object ? [{ key, object }] : [];
    });
    if (away.length && !this.bucket) return { error: "这段语音存在 R2 里，可现在没有绑 KEPT_VOICES：绑回去再取消收藏" };
    const lost: string[] = [];
    for (const { key, object } of away) {
      const found = await this.bucket!.get(object);
      if (found) this.media.bringBack(key, object, new Uint8Array(await found.arrayBuffer()));
      if (this.media.awayTo(key) === object) lost.push(key);
    }
    this.media.unkeep(message);
    for (const key of lost) this.media.remove(key);
    // The copies read back are to clear now (bringBack wrote them down); their names are never used again.
    await this.flush();
    this.media.prune();
    return { ok: true };
  }

  /**
   * A voice file, from SQLite or, kept in the bucket, from there. Where it is can change while it is read (let go and
   * kept again meanwhile: back in SQLite, then a new copy under a new name), so a copy no longer there is looked
   * for again where the file is now, a few times.
   */
  async file(key: string): Promise<MediaFile | null> {
    for (let tries = 0; tries < 3; tries++) {
      const here = this.media.get(key);
      const away = this.media.awayTo(key);
      if (here || !this.bucket || !away) return here;
      const about = this.media.about(key);
      if (!about) return null;
      const object = await this.bucket.get(away);
      if (object) return { type: about.type, seconds: about.seconds, bytes: new Uint8Array(await object.arrayBuffer()) };
      // Still where it was looked for, and not there: lost, unless it came back into SQLite.
      if (this.media.awayTo(key) === away) return this.media.get(key);
    }
    return this.media.get(key);
  }

  /** The copies in the bucket no file points to (a reply taken back, a clearing that failed) go, once it is bound. */
  clear(): Promise<void> {
    return this.run(() => this.flush());
  }

  /**
   * Why this resident cannot be deleted yet, if it cannot: voices of it are in the bucket, and the bucket is not bound
   * now, so deleting it would leave them there with nothing to find them by.
   */
  forgetProblem(): string | null {
    return !this.bucket && this.media.anyAway() ? "它的语音收藏存在 R2 里，可现在没有绑 KEPT_VOICES：绑回去再删，不然那些语音会留在 R2 里" : null;
  }

  /**
   * Everything this resident has in the bucket goes, when the resident itself does, after any keep under way, and
   * nothing is kept after it. Throws when it cannot (forgetProblem).
   */
  forgetAll(): Promise<void> {
    return this.run(async () => {
      this.#closed = true;
      const problem = this.forgetProblem();
      if (problem) throw new Error(problem);
      if (!this.bucket) return;
      await this.flush();
      if (this.media.toClear().length) throw new Error("kept voices: some could not be cleared from R2");
      let cursor: string | undefined;
      do {
        const page = await this.bucket.list({ prefix: keptPrefix(this.resident), ...(cursor ? { cursor } : {}) });
        if (page.objects.length) await this.bucket.delete(page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    });
  }
}
