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
  AELIOS_URL?: string;
  AELIOS_NAMESPACE?: string;
  // The identity in Aelios' admin page the chat goes out as (via-aelios.ts); empty for the key's first one.
  AELIOS_IDENTITY?: string;
  WEB_SEARCH?: string;
  WEB_FETCH?: string;
  WEB_FETCH_MODEL?: string;
  // A provider of your own (custom.ts): its address up to /v1, and openai (default) or anthropic.
  CUSTOM_BASE_URL?: string;
  CUSTOM_FORMAT?: string;
  CHECKIN_SCHEDULE?: string;
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
  WEB_KEY?: string;
}
