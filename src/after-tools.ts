// A turn that has answered and then calls tools (remember this, send a sticker) sometimes speaks again once the
// results are back: its answer once more, or a line like "No response requested." Every word of a turn goes out, so
// she gets a second message that says nothing. Words written after tools, in a turn that had already said
// something, are held until each block of them ends: if they only repeat what was said or say there is nothing to
// say, they never go out and are not kept. Anything new goes out as it is. The same for the Claude box, whose
// continuation after the tools is a step of its own here.

import type { StreamTextTransform, TextStreamPart, ToolSet } from "ai";

/** What models write when a tool's result needs no answer, compared plain (see plain()). */
const NOTHING_TO_SAY = new Set([
  "noresponserequested",
  "noresponseneeded",
  "noresponserequired",
  "noresponse",
  "nofurtherresponseneeded",
  "nofurtherresponse",
  "noreplyneeded",
  "noreplyrequested",
  "noreply",
  "nothingtoadd",
  "nothingmoretoadd",
  "nothingelsetoadd",
  "无需回复",
  "无需再回复",
  "无需额外回复",
  "不需要回复",
  "不用回复",
  "无需回应",
  "不回复",
  "没有要补充的"
]);

/** Letters, digits and characters only: case, spaces, punctuation and emoji do not count. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function pairs(text: string): Set<string> {
  const chars = Array.from(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/**
 * Whether words written after the tools came back add nothing to what the turn said before them: blank, a line that
 * says there is nothing to say, or mostly the same words again (most of their character pairs are in what was said).
 */
export function addsNothing(said: string, text: string): boolean {
  if (!text.trim()) return true;
  const now = plain(text);
  if (!now) return false;
  if (NOTHING_TO_SAY.has(now)) return true;
  const before = plain(said);
  if (!before) return false;
  if (before.includes(now)) return true;
  const mine = pairs(now);
  if (mine.size < 4) return false;
  const theirs = pairs(before);
  let same = 0;
  for (const pair of mine) if (theirs.has(pair)) same += 1;
  return same / mine.size >= 0.7;
}

/** Longest words or thinking are held back before they go out anyway, well inside the stream's stall watchdog. */
const HOLD_MS = 60_000;

/**
 * The turn's stream with the words that add nothing after tools left out (an AI SDK experimental_transform). A step
 * whose words are all left out and that calls no tool loses its thinking too, so no reply is kept that is only
 * thinking.
 */
export function quietAfterTools<TOOLS extends ToolSet = ToolSet>(): StreamTextTransform<TOOLS> {
  return () => {
    type Part = TextStreamPart<TOOLS>;
    // What the turn has said so far, and whether the step now running follows one that called tools.
    let said = "";
    let afterTools = false;
    // The step now running: whether its words are judged, whether it called a tool or let something out, since when
    // it holds anything, its thinking (held until it is known to say something) and the block of words being written.
    let judging = false;
    let calls = false;
    let since = 0;
    let thinking: Part[] = [];
    let words: Part[] | null = null;
    let text = "";

    return new TransformStream<Part, Part>({
      transform(part, controller) {
        const out = (parts: Part[]) => {
          for (const held of parts) controller.enqueue(held);
        };
        // The step said something, or holding has gone on too long: what is held goes out, in order.
        const letOut = () => {
          out(thinking);
          thinking = [];
          if (words) {
            out(words);
            said += text;
            words = null;
            text = "";
          }
        };
        const tooLong = () => Date.now() - since > HOLD_MS;

        switch (part.type) {
          case "start-step":
            judging = afterTools && said.trim() !== "";
            calls = false;
            since = Date.now();
            thinking = [];
            words = null;
            text = "";
            controller.enqueue(part);
            return;
          case "text-start":
            if (!judging) break;
            // A block that starts before the last one ended (they interleave): that one goes out unjudged.
            if (words) letOut();
            words = [part];
            text = "";
            return;
          case "text-delta":
            if (!words) {
              said += part.text;
              break;
            }
            words.push(part);
            text += part.text;
            if (tooLong()) {
              letOut();
              judging = false;
            }
            return;
          case "text-end":
            if (!words) break;
            words.push(part);
            if (addsNothing(said, text)) {
              words = null;
              text = "";
            } else {
              letOut();
            }
            return;
          case "reasoning-start":
          case "reasoning-delta":
          case "reasoning-end":
            if (!judging) break;
            thinking.push(part);
            if (tooLong()) {
              letOut();
              judging = false;
            }
            return;
          case "finish-step":
            // Words cut off before their block ended go out as they are; thinking stays with the calls it led to,
            // and goes with words that were left out.
            if (words) letOut();
            if (calls) out(thinking);
            thinking = [];
            judging = false;
            afterTools = calls;
            controller.enqueue(part);
            return;
          default:
            if (part.type === "tool-input-start" || part.type === "tool-call") calls = true;
            if (judging) letOut();
            break;
        }
        controller.enqueue(part);
      },
      flush(controller) {
        // A stream that ends mid-step: what is held goes out, nothing judged on half a step.
        for (const held of thinking) controller.enqueue(held);
        for (const held of words ?? []) controller.enqueue(held);
      }
    });
  };
}
