# Verification note (iteration 1 — implementation complete)

Commands run at the workspace root on the Windows/PowerShell host, npm:

- `npm install` — succeeded (197 packages added; esbuild postinstall scripts
  approved via `npm install-scripts approve esbuild` so vitest/esbuild can run).
- `npx tsc --noEmit` — PASS (exit 0, no type errors across `api/`, `lib/`, `tests/`).
- `npm test` (→ `vitest run`) — PASS: **8 test files, 63 tests, all green.**
  - detector.test.ts (22), telegram.test.ts (11), handler.test.ts (9),
    mapping.test.ts (8), config.test.ts (5), supabase.test.ts (3),
    webhook.test.ts (3), integration.test.ts (2).

Zero live network calls: `fetch`, the Supabase client, and (in webhook unit
tests) the handler/config are all mocked. The real BotFather token is NOT present
anywhere in the repo; `.env.example` carries placeholder values only.

---

# Implementation Plan — Telegram Account Relay Bot

This plan maps the approved Kiro spec (`.kiro/specs/telegram-account-relay-bot/{requirements,design,tasks}.md`)
to concrete files and the invariants the implementer must preserve. It follows the spec's own
10-task / 6-wave order. Do NOT re-decide architecture; the design document is the contract.
Do NOT add any feature beyond the spec. Project is greenfield TypeScript at the workspace root,
single Vercel Serverless Function, Windows host, PowerShell, npm.

## Non-negotiable constraints (implementer AND reviewer must check all of these)

- **File layout at workspace root** — exactly these files, no extras:
  `package.json` (`"type":"module"`, `test` script -> `vitest`), `tsconfig.json` (strict, ESM),
  `vercel.json`, `vitest.config.ts`, `.env.example` (`BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`
  with PLACEHOLDER values only — NEVER the real token), `.gitignore` (`node_modules`, `.env`,
  build output), `api/webhook.ts`, `lib/types.ts`, `lib/config.ts`, `lib/detector.ts`,
  `lib/telegram.ts`, `lib/supabase.ts`, `lib/handler.ts`, a display-name / field-mapping helper
  (`lib/mapping.ts`), and tests under `tests/`.
- **Byte-for-byte Vietnamese strings** — preserve EXACTLY, no edits to spacing, punctuation, emoji, or diacritics:
  - `LogStatus = "Đã gửi Inbox" | "Lỗi chưa start bot" | "Đã thu hồi"`
  - Group confirmation: `🔒 [Tên CTV] đã gửi thông tin Tài khoản / Mật khẩu vào Inbox cá nhân của QLL.`
    with `[Tên CTV]` replaced by the CTV display name.
  - 403 / timeout warning: `⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox.`
- **Detector contract** — `detector.isSensitive(text)`: NFD normalize + strip combining marks
  (`/[\u0300-\u036f]/g`) + lowercase; keyword match via word-boundary `/\b(tk|mk)\b/` plus
  `tai khoan` / `mat khau` and colon variants (`tk:`, `mk:`); OR after removing spaces/dashes/dots
  (`/[\s.\-]/g`) a run of 8+ digits (`/\d{8,}/`). `false` otherwise.
- **Telegram wrapper** — native `fetch`; `sendMessage` + `deleteMessage`; classify `error_code: 403`
  as `forbidden: true`; `withTimeout(p, 10000)`; `deleteWithRetry` max 3 attempts.
- **Supabase** — `getClient(url, key)` + non-throwing `insertLog` into pre-existing table
  `bot_account_logs`. NO schema migration in code.
- **Config** — `loadConfig()` validates `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY` from
  `process.env`; throws naming the FIRST missing var.
- **Handler ordering (critical)** — sensitive group reply: send-to-inbox FIRST (wrapped in
  `withTimeout` 10s); on success -> `deleteWithRetry` -> log `"Đã gửi Inbox"` -> post confirmation.
  On 403 OR timeout (treated identically) -> `deleteWithRetry` FIRST -> log `"Lỗi chưa start bot"`
  -> post ⚠️ warning. On other non-success -> retain reply (no delete), log delivery-failure.
- **Webhook** — parse Telegram `Update`; `loadConfig()` (throw -> HTTP 500); build deps; call
  `handleUpdate`; ALWAYS return 200 for handled message-processing outcomes; only missing-config -> non-200.
- **Tests** — vitest run mode, ZERO live network (fetch / supabase / handler / config mocked).
- **README** — operational notes only (setWebhook, privacy disable, admin delete right, QLL `/start`,
  Vercel env vars, reference SQL documented NOT executed).

## Design decisions recorded (no separate design doc exists beyond the spec)

- The display-name / field-mapping helper lives in a single new file `lib/mapping.ts` (the spec names
  the functions but not a file). Rationale: keeps `handler.ts` free of derivation logic and gives the
  mapping its own unit-test surface, matching the spec's "small single-responsibility modules" intent.
- Internal (non-glossary) `status` markers for delivery-failure and deletion-failure are plain strings
  stored in the `status` column, kept distinct from the three glossary `LogStatus` values. Rationale:
  the design's Error Handling table and Property 8 call for these as audit markers; the `LogStatus`
  union stays the three glossary strings and the internal markers are passed as `string` on those paths.

## Build & test commands (discovered: greenfield, use npm + vitest)

- Install: `npm install`
- Typecheck: `npx tsc --noEmit`
- Run tests: `npm test` (-> `vitest run`)

---

# Implementation Plan (ordered, dependency-sequenced)

- [ ] 1. Scaffold the project and tooling at the workspace root.
      Create `package.json` (`"type":"module"`, `"test":"vitest run"`), `tsconfig.json` (strict + ESM:
      `module`/`moduleResolution` for NodeNext, `target` modern), `vercel.json` (serve `api/webhook.ts`
      as a serverless function), `vitest.config.ts`, `.env.example` (the three vars with PLACEHOLDER
      values only), `.gitignore` (`node_modules`, `.env`, build output). Install `@supabase/supabase-js`;
      dev-install `vitest`, `@vercel/node`, `typescript`.
      Files: `package.json`, `tsconfig.json`, `vercel.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
      Verify: `npm install` succeeds; `npx tsc --noEmit` runs with no config errors; `npm test` runs vitest
      (0 tests is acceptable at this point).
      _Spec task 1 — Requirements 8.2, 9.1_

- [ ] 2. Define shared types in `lib/types.ts`.
      Add `TelegramUser`, `TelegramChat`, `TelegramMessage`, `TelegramUpdate` (the subset in design.md),
      the `LogStatus` union with the three Vietnamese strings EXACT, and `LogRecord` with all
      `bot_account_logs` columns (`created_at`, `qll_telegram_id`, `qll_name`, `request_content`,
      `ctv_name`, `response_content`, `status`).
      Files: `lib/types.ts`
      Verify: `npx tsc --noEmit` passes.
      _Spec task 2 — Requirements 7, 9. Depends on 1._

- [ ] 3. Implement `lib/config.ts`.
      Define `Config` (`botToken`, `supabaseUrl`, `supabaseKey`) and `loadConfig()` reading the three
      `process.env` vars; throw a descriptive error naming the FIRST missing/empty var. Add
      `tests/config.test.ts`: all vars present returns a `Config`; each missing var throws naming that var
      (stub `process.env` per test).
      Files: `lib/config.ts`, `tests/config.test.ts`
      Verify: `npm test` — config tests pass; `npx tsc --noEmit` passes.
      _Spec task 3 — Requirements 8.1, 8.3. Depends on 1._

- [ ] 4. Implement `lib/detector.ts`.
      `isSensitive(text)`: normalize (NFD + strip `/[\u0300-\u036f]/g` + lowercase); keyword rule with
      `/\b(tk|mk)\b/` plus `tai khoan` / `mat khau` and colon variants; numeric rule strips `/[\s.\-]/g`
      then tests `/\d{8,}/`; returns `true` on either rule else `false`. Add `tests/detector.test.ts`
      covering positives (`TK`, `tk`, `MK`, `Tài khoản`, `TÀI KHOẢN`, `tai khoan`, `Mật khẩu`, `mat khau`,
      `TK:`, `mk:`), separated 8+ digit numbers (`01234567`, `0123 456 789`, `0123-456-789`,
      `0123.456.789`), and negatives (7-digit `1234567`, plain chat, words incidentally containing t/k or m/k).
      Files: `lib/detector.ts`, `tests/detector.test.ts`
      Verify: `npm test` — detector tests pass.
      _Spec task 4 — Requirements 3.1, 3.2, 3.3. Depends on 2._

- [ ] 5. Implement `lib/telegram.ts`.
      `createTelegramClient(botToken)` exposing `sendMessage(chatId, text)` and
      `deleteMessage(chatId, messageId)` over native `fetch`, returning `SendResult` / `DeleteResult`;
      set `forbidden: true` on `error_code: 403`. Add `withTimeout(p, ms)` (rejects on timeout) and
      `deleteWithRetry(client, chatId, messageId, attempts = 3)`. Add `tests/telegram.test.ts` with `fetch`
      mocked: success send, 403 send, non-403 failure, timeout, delete success/failure, retries stop at 3.
      Files: `lib/telegram.ts`, `tests/telegram.test.ts`
      Verify: `npm test` — telegram tests pass; no live network (fetch mocked).
      _Spec task 5 — Requirements 2.1, 2.2, 2.4, 4.1, 4.5. Depends on 2._

- [ ] 6. Implement the display-name / field-mapping helper in `lib/mapping.ts`.
      `displayName(user)` = first+" "+last when last present, else first, else `username`, else `""`.
      A `buildLogRecord(message, status)` (or equivalent) deriving `LogRecord` from `message` and
      `message.reply_to_message`: `created_at` = `new Date(reply_to_message.date * 1000).toISOString()`;
      `qll_telegram_id` = `String(reply_to_message.from.id)`; `qll_name` via `displayName(reply_to.from)`;
      `request_content` = `reply_to_message.text ?? ""`; `ctv_name` via `displayName(message.from)`;
      `response_content` = `message.text` (byte-for-byte). Add `tests/mapping.test.ts`: first+last,
      first only, username fallback, empty/missing reply text -> `""`, `created_at` ISO UTC conversion.
      Files: `lib/mapping.ts`, `tests/mapping.test.ts`
      Verify: `npm test` — mapping tests pass.
      _Spec task 6 — Requirements 7.1–7.6. Depends on 2._

- [ ] 7. Implement `lib/supabase.ts`.
      `getClient(url, key)` returns a `SupabaseClient`; `insertLog(client, record)` does a single
      `client.from("bot_account_logs").insert(record)` and resolves `{ ok: false, error }` on failure
      (never throws). NO migrations. Add `tests/supabase.test.ts` with the client mocked: success ->
      `{ ok: true }`; errored/rejected insert -> `{ ok: false }` without throwing.
      Files: `lib/supabase.ts`, `tests/supabase.test.ts`
      Verify: `npm test` — supabase tests pass; no live network.
      _Spec task 7 — Requirements 7, 9.3. Depends on 2._

- [ ] 8. Implement core orchestration in `lib/handler.ts`.
      `handleUpdate(update, deps = { telegram, supabase })` with injected clients. Branches, in order:
      private-chat `/start` -> acknowledge inbox open (reply only); group message with no
      `reply_to_message` -> ignore; group reply where `isSensitive` is false -> ignore; sensitive group
      reply -> relay flow. Relay flow: `withTimeout(telegram.sendMessage(qllId, message.text), 10000)`
      FIRST; on success -> `deleteWithRetry` -> `insertLog("Đã gửi Inbox")` -> post confirmation line
      (CTV name substituted); on 403 OR timeout (identical) -> `deleteWithRetry` FIRST ->
      `insertLog("Lỗi chưa start bot")` -> post ⚠️ warning; on other non-success -> retain reply (no delete)
      -> log delivery-failure; on delete-retry exhaustion (after successful send) -> log deletion-failure.
      Use `buildLogRecord` from `lib/mapping.ts`. All Vietnamese strings EXACT. Add `tests/handler.test.ts`
      with mocked `telegram` + `supabase` asserting call ORDER (send-before-delete on happy path,
      delete-before-warning on 403 path) and EXACT strings: happy path, 403, timeout, non-403, delete-retry
      exhaustion, non-reply ignore, non-sensitive ignore, `/start`. Assert exactly one `insertLog` per
      processed sensitive reply; zero Telegram/Supabase calls on ignore branches.
      Files: `lib/handler.ts`, `tests/handler.test.ts`
      Verify: `npm test` — all handler branch tests pass.
      _Spec task 8 — Requirements 1, 2, 3, 4, 5, 6, 7, 10. Depends on 3, 4, 5, 6, 7._

- [ ] 9. Implement the entry point in `api/webhook.ts`.
      Default-export a `(req, res)` handler. Parse the request body as a Telegram `Update`; call
      `loadConfig()` (if it throws -> respond HTTP 500); build `Deps` from `createTelegramClient(botToken)`
      and `getClient(supabaseUrl, supabaseKey)`; call `handleUpdate(update, deps)`; ALWAYS respond HTTP 200
      for handled message-processing outcomes (including handled errors) so Telegram does not re-deliver.
      Add `tests/webhook.test.ts` with `handler` + `config` mocked: valid update -> 200; missing-config -> 500.
      Files: `api/webhook.ts`, `tests/webhook.test.ts`
      Verify: `npm test` — webhook tests pass; `npx tsc --noEmit` passes.
      _Spec task 9 — Requirements 8.3, 9.1, 9.2, 10.2. Depends on 3, 8._

- [ ] 10. Final wiring, integration test, and README.
      Add `tests/integration.test.ts` exercising `api/webhook.ts` end-to-end with mocked Telegram/Supabase
      for the happy path (valid sensitive reply -> 200) and the 403 path. Write `README.md` with operational
      setup notes ONLY: `setWebhook` registration (`https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<deployment>/api/webhook`),
      BotFather `/setprivacy` -> Disable, granting the bot the group "Delete messages" admin right, QLL
      sending `/start` once, provisioning the three env vars on Vercel, and the reference SQL for
      `bot_account_logs` (documented, NOT executed by code). Do not put the real token anywhere.
      Files: `tests/integration.test.ts`, `README.md`
      Verify: `npm test` — full suite (including integration) passes; `npx tsc --noEmit` passes.
      _Spec task 10 — Requirements 8.2, 9. Depends on 9._

## Known gaps / assumptions

- The spec names the display-name/field-mapping functions but not a file; assumed `lib/mapping.ts`
  (see design decision above). If the implementer prefers co-locating in `lib/types.ts` or `lib/handler.ts`,
  the mapping must still have its own tests per spec task 6.
- `tsconfig` module setting assumed `NodeNext` (ESM) to satisfy `"type":"module"` + `@vercel/node`.
- Internal delivery-failure / deletion-failure `status` strings are not fixed by the spec; the implementer
  picks clear literals (e.g. `"Lỗi gửi Inbox"` / `"Lỗi thu hồi"`), kept distinct from the three glossary
  `LogStatus` values. These are audit markers only and must not alter the three byte-exact user-facing strings.
