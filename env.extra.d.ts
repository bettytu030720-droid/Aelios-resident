// Settings and secrets, all optional: the code has a default for each (see README).
// Declared here because wrangler.jsonc carries no vars (they would overwrite the Dashboard on deploy).
interface Env {
  MODEL?: string;
  AI_GATEWAY_ID?: string;
  TG_BOT_USERNAME?: string;
  TG_ALLOWED?: string;
  TIME_ZONE?: string;
  DEBOUNCE_SECONDS?: string;
  LETTER_AFTER_TOKENS?: string;
  KEEP_RECENT_TOKENS?: string;
  SHOW_LETTER?: string;
  AELIOS_URL?: string;
  AELIOS_NAMESPACE?: string;
  WEB_SEARCH?: string;
  FETCH_ALLOWLIST?: string;
  CHECKIN_SCHEDULE?: string;
  TG_BOT_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  TG_API_BASE?: string;
  AELIOS_API_KEY?: string;
  WEB_KEY?: string;
}
