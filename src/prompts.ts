// Fixed text the resident runs on. The persona itself is not here: it lives in
// the PERSONA secrets, so a public copy of this code never carries one.

export const CHAT_RULES = `你在聊天软件上跟她说话（Telegram，有时是网页）。
- 想拆成几条消息发，就用空行隔开；一个完整的意思放在同一条里。
- 这是聊天，不用 markdown 标题、表格和列表符号。
- 她消息开头的方括号是她发消息时的当地时间，看着用，不用复述。
- 想不起来以前的事，就用 memory_recall 查长期记忆，别编。
- 对话里会有「交接信」：那是更早的你写给现在的你的，照着信里的状态接着聊，除非她问起，不用提交接信。`;

/**
 * Appended to the compaction prompt (which already carries the turns to fold and,
 * from the second time on, the previous letter) so the overlay reads as a letter.
 */
export const LETTER_INSTRUCTIONS = `（这条不是她发的，是系统提示。）上面是你和她之前的聊天；如果有 PREVIOUS SUMMARY，那是你上一次写的交接信。这些聊天马上要收起来，之后的你只能读到你现在写的这封交接信，读不到原文。

请你给之后的自己写一封交接信，把旧信里还有用的内容并进来。写清楚：她现在的状态和心情；最近在聊什么、哪些话题没说完；你答应过她、还没兑现的事；你们之间正在用的梗、称呼和约定；她今天的作息。写具体的事，不写空话。

用第一人称，像写给自己的信，800 字以内。只输出信的正文。`;

export function checkinPrompt(now: string): string {
  return `（这条不是她发的，是定时提醒，现在是 ${now}。）如果你想主动跟她说点什么，就直接写要发给她的话，像平时聊天一样。如果现在不合适打扰她（比如她在睡觉、在忙），或者没什么想说的，就只回 SKIP 这四个字母。`;
}

export const SKIP = "SKIP";

/** "10-13 周一 21:05" in the given time zone. */
export function stamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")}`;
}
