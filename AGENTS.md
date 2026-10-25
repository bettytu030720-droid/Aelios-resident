# AGENTS.md

Aelios-resident is an AI companion that runs as one Cloudflare Worker (`aelios-resident`) with one Durable Object, built on Cloudflare's Think. People talk to it on Telegram and on its web door. With [Aelios](https://github.com/wusaki0723/Aelios) connected it chats through Aelios and remembers.

## If the user wants the resident set up

Follow [docs/setup-with-ai.md](docs/setup-with-ai.md) step by step. It starts from a fresh Cloudflare account (fork and deploy), generates the web door key, connects Telegram, gives the resident an identity in Aelios, picks the model and fills the settings through the web door's API. Users who already have a resident skip the deploy step. If they want long-term memory and have no Aelios yet, set up Aelios first with its own guide.

## Rules that apply to every task in this repo

- Deploy with `npm run deploy`. Do not rename the Worker in `wrangler.jsonc`, and do not add `vars` there: a value in the file overwrites what the user set in the Dashboard on every deploy. Settings belong on the web door's settings page (or `POST /web/config`).
- Never write secrets into any tracked file, and never ask the user to paste a Telegram bot token, Cloudflare API token, GitHub token or model provider key into the chat. The user stores the bot token and provider keys in Cloudflare themselves. A secret you generate goes straight into a Worker secret through a pipe (`printf %s "$S" | npx wrangler secret put NAME`); never print `TG_WEBHOOK_SECRET` or write it to a file. The web door key `WEB_KEY` is the one you hand to the user.
- Never delete or replace the `aelios-resident` Worker, its secrets, or an Aelios identity without the user's explicit go-ahead. The conversation, persona and stickers live in the Durable Object.
- The repository is public and other people deploy it. Keep features general and behind a setting; no one's private addresses, names or data in code, docs or tests.

## Working on the code

- Node.js 22+. Install with `npm ci`.
- Before a PR: `npm run typecheck`, then the tests in [docs/testing.md](docs/testing.md) for the parts you touched. They run against fake Telegram, fake Aelios and a scripted model, so they cost nothing and need no Cloudflare login.
- User-facing docs: `README.md` is in English (the default) and `README.zh-CN.md` in Chinese; change both together. `docs/` is in Chinese.
