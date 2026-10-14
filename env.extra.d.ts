// Secrets and test-only values. Declared here because `wrangler types` only sees vars.
interface Env {
  TG_BOT_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  TG_API_BASE?: string;
  AELIOS_API_KEY?: string;
  WEB_KEY?: string;
}
