# Telegram Account Relay Bot

A single Vercel Serverless Function (TypeScript) that protects sensitive account
credentials (Tài khoản / Mật khẩu) shared in a working group. When a collaborator
(CTV) replies to a manager's (QLL) account request with credential text, the bot:

1. relays the exact credential text to the QLL's private inbox,
2. deletes the sensitive reply from the group,
3. logs the exchange to Supabase (`bot_account_logs`), and
4. posts a non-sensitive confirmation line in the group.

The whole bot lives in `api/webhook.ts` plus small modules under `lib/`.

## Project layout

```
api/webhook.ts     Vercel Serverless Function (HTTP boundary)
lib/config.ts      Reads/validates BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY
lib/types.ts       Telegram + log-row types
lib/detector.ts    Sensitive-content detection (TK/MK keywords, 8+ digit runs)
lib/telegram.ts    Telegram Bot API wrapper (fetch), timeout, delete retries
lib/supabase.ts    Supabase logger (non-throwing insert)
lib/mapping.ts     Display-name + LogRecord field mapping
lib/handler.ts     Core orchestration / relay flow
tests/             Vitest suite (fully mocked, zero live network)
```

## Local development

```powershell
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Copy `.env.example` to `.env` and fill in real values for local use. `.env` is
git-ignored and must never be committed.

## Environment variables

Set these on Vercel (Project → Settings → Environment Variables) and locally in
`.env`:

| Variable       | Description                                             |
| -------------- | ------------------------------------------------------- |
| `BOT_TOKEN`    | Telegram Bot API token from BotFather                   |
| `SUPABASE_URL` | Supabase project URL (`https://<project>.supabase.co`)  |
| `SUPABASE_KEY` | Supabase key with insert rights on `bot_account_logs`   |

If any variable is missing at runtime, the webhook returns HTTP 500.

## Operational setup (one-time)

These steps are performed by you outside the code.

### 1. Deploy to Vercel

Deploy the project. The function is served at:

```
https://<your-deployment>/api/webhook
```

### 2. Register the Telegram webhook (`setWebhook`)

Point Telegram at your deployment so updates are pushed to the function:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-deployment>/api/webhook
```

Open that URL in a browser (or via curl) once. Telegram should respond with
`{"ok":true, ...}`.

### 3. Disable group privacy mode (BotFather `/setprivacy` → Disable)

In BotFather, run `/setprivacy`, pick your bot, and choose **Disable**. With
privacy mode disabled the bot receives all group messages (including replies it
did not author), not just commands and @mentions. This is required for the bot
to see CTV replies.

### 4. Grant the bot the group "Delete messages" admin right

Add the bot to the shared group as an **administrator** and enable the
**Delete messages** permission. Without this right, `deleteMessage` fails and the
sensitive reply cannot be removed.

### 5. QLL must `/start` the bot once

Telegram forbids a bot from messaging a user who has never opened a chat with it.
Each QLL must send `/start` to the bot in a private chat once. Until then,
delivery to that user returns 403 and the bot takes the security path: it still
deletes the credential reply from the group and posts a warning asking the QLL to
`/start`.

### 6. Create / verify the `bot_account_logs` table

The bot assumes this table already exists and never runs a migration. Create or
verify it yourself in the Supabase SQL editor:

```sql
-- Run this yourself in the Supabase SQL editor. The bot does NOT run it.
CREATE TABLE bot_account_logs (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at       timestamptz,
  qll_telegram_id  text,
  qll_name         text,
  request_content  text,
  ctv_name         text,
  response_content text,
  status           text
);
```

`created_at` is set explicitly by the bot from the original request's timestamp
(ISO UTC), not by a column default.

## Behavior summary

- **Private `/start`** → the bot replies acknowledging the inbox is open.
- **Group message that is not a reply** → ignored.
- **Group reply that is not sensitive** → ignored.
- **Group reply that is sensitive** → relay flow:
  - send to the QLL inbox **first** (10s timeout);
  - on success → delete the group reply (up to 3 retries) → log `Đã gửi Inbox`
    → post the confirmation line;
  - on **403 or timeout** → delete the group reply **first** → log
    `Lỗi chưa start bot` → post the ⚠️ warning;
  - on any other delivery failure → retain the reply (no delete) and log a
    delivery-failure marker.

The webhook always returns HTTP 200 for handled message-processing outcomes so
Telegram does not retry; only a missing-config error yields HTTP 500.
