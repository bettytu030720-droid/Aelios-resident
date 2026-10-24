// Settings and secrets, all optional: the code has a default for each (see README).
// Declared here because wrangler.jsonc carries no vars (they would overwrite the Dashboard on deploy).
interface Env {
  // The old model variable: read once and moved onto the web page (see Resident.savedModel).
  MODEL?: string;
  AI_GATEWAY_ID?: string;
  TG_BOT_USERNAME?: string;
  TG_ALLOWED?: string;
  TIME_ZONE?: string;
  DEBOUNCE_SECONDS?: string;
  KEEP_RECENT_TOKENS?: string;
  LETTER_IDLE_MINUTES?: string;
  CACHE_TTL?: string;
  // How much Claude thinks (thinking.ts): auto (its own default), low, medium, high, xhigh or max.
  THINKING_EFFORT?: string;
  AELIOS_URL?: string;
  AELIOS_NAMESPACE?: string;
  // The identity in Aelios' admin page the chat goes out as (via-aelios.ts); empty for the key's first one.
  AELIOS_IDENTITY?: string;
  WEB_SEARCH?: string;
  // What lasts from a web search goes into Aelios as world knowledge (web/learn.ts); off turns it off.
  WEB_LEARN?: string;
  WEB_FETCH?: string;
  // Stickers (stickers.ts): on (default) or off, which takes send_sticker and make_sticker away.
  STICKERS?: string;
  WEB_FETCH_MODEL?: string;
  // A provider of your own (custom.ts): its address up to /v1, and openai (default) or anthropic.
  CUSTOM_BASE_URL?: string;
  CUSTOM_FORMAT?: string;
  CHECKIN_SCHEDULE?: string;
  // When the letter's time comes and there is nothing to fold yet, ask whether to reach out, up to this many times
  // in one quiet time: 3 by default, 0 or off never, at most 10.
  HEARTBEAT?: string;
  // Alarms the resident sets for itself (alarms.ts): off (default) or on.
  ALARMS?: string;
  // Local tests only: how many seconds a minute of set_alarm's in_minutes lasts.
  ALARM_MINUTE_SECONDS?: string;
  // Voice messages (voice.ts): off (default), openrouter, elevenlabs or cartesia; the model and the voice it speaks in;
  // mirror (a voice message is answered with one, default), always, or tool (only when the resident chooses to).
  VOICE_PROVIDER?: string;
  VOICE_MODEL?: string;
  VOICE_ID?: string;
  VOICE_REPLY?: string;
  // Sends voice requests straight there instead of through AI Gateway (a proxy; the local tests).
  VOICE_BASE_URL?: string;
  // Cloud Claude Code as the resident's hands (cloud-tasks.ts): a scheduled task's API trigger, its address and token.
  CLOUD_TASKS?: string;
  CLOUD_TASK_URL?: string;
  CLOUD_TASK_TOKEN?: string;
  // Local tests only: where the trigger is fired instead of api.anthropic.com, and how many minutes before a task is quiet.
  CLOUD_TASK_API_BASE?: string;
  CLOUD_TASK_QUIET_MINUTES?: string;
  TG_BOT_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  TG_API_BASE?: string;
  // Local tests only: the default model is the scripted one.
  FAKE_MODEL?: string;
  AELIOS_API_KEY?: string;
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  CUSTOM_API_KEY?: string;
  // Empty: AI Gateway uses the key stored on the gateway for the voice provider (BYOK).
  VOICE_API_KEY?: string;
  WEB_KEY?: string;
}
