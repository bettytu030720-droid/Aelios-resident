// Taking back its latest reply, from its long-press menu on the web page: 删掉 deletes it, 重新生成 deletes it
// and has it answer her message again. For a reply that came out as an error, garbled tokens or a flat
// refusal: once gone, no later turn sees it. Only the latest reply can go, so everything before it stays as it was
// and the prompt cache still holds. Check-ins it passed on since (a heartbeat that said SKIP, not shown on the
// page) go with it.
//
// With Aelios connected, Aelios keeps its own record of what was said; that line is deleted on Aelios' admin page
// (今天的对话). A reply asked for again goes to Aelios as a new exchange (via-aelios.ts), so it is recorded too.

import { isCheckin, isNote, SKIP } from "./prompts";

type Message = { id: string; role: string; parts: readonly { type: string; text?: string }[] };

function said(message: Message): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
}

const folded = (message: Message) => message.id.startsWith("compaction_");
// What a group chat handed it (Resident.groupHear) is answered in the group: asked again here, the answer would not get there.
const fromGroup = (message: Message) => message.id.startsWith("group_");

/**
 * What goes with the reply `id` on the conversation's current path: the whole reply it is part of (its messages
 * with nothing of hers between), and the passed check-ins after it. `again`: the message before them is one of hers, so it can
 * be answered again (a check-in, a thread's report or what a group chat handed it cannot).
 */
export function takeBack(path: readonly Message[], id: string): { ids: string[]; again: boolean } | { error: string } {
  const at = path.findIndex((message) => message.id === id);
  if (at < 0 || path[at].role !== "assistant" || folded(path[at])) return { error: "这条已经不在了" };
  // After it: the rest of the same reply, then only check-ins it passed on.
  let checkin = false;
  for (const message of path.slice(at + 1)) {
    if (message.role === "user") checkin = isCheckin(said(message));
    const fine = message.role === "user" ? checkin : message.role === "assistant" && (!checkin || [SKIP, ""].includes(said(message)));
    if (!fine || folded(message)) return { error: "只能收回最后一条" };
  }
  let start = at;
  while (start > 0 && path[start - 1].role === "assistant" && !folded(path[start - 1])) start -= 1;
  const before = path[start - 1];
  return {
    ids: path.slice(start).map((message) => message.id),
    again: Boolean(before && before.role === "user" && !folded(before) && !fromGroup(before) && !isNote(said(before)))
  };
}
