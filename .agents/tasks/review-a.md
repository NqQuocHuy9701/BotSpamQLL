# Spec conformance and correctness — Telegram Account Relay Bot

The implementation routes a Telegram update through `handleUpdate`, which classifies the update and runs the relay flow for a sensitive group reply: deliver the credential to the QLL inbox first, delete the group reply only after confirmed delivery, log one row to Supabase, and post a confirmation line. On a 403 or a 10-second timeout it switches to the security path: delete first, then log, then warn. I checked the handler branch logic and ordering, the detector rules, config validation, the LogRecord field mapping, every user-facing Vietnamese string, the `LogStatus` union, and the recorded test evidence against the three spec files and the plan note.

Watch for: nothing blocking. All byte-sensitive strings match the spec exactly (confirmed), branch ordering matches the spec on both the happy and security paths (confirmed), and the recorded `tsc --noEmit` + `vitest run` evidence shows the suite green (confirmed via plan.md and matching test files on disk).

**Verdict**: APPROVED

## High-level view

Branch ordering is faithful to the spec. The sensitive-reply flow sends to the inbox under a 10s timeout first and deletes only after a confirmed success; the 403 path and the timeout path both delete before any warning and are driven through identical code. Non-403 send failures retain the reply with no delete. Delete retries are bounded at 3 on both paths.

Every byte-sensitive string lines up with the spec: the `LogStatus` union (`"Đã gửi Inbox" | "Lỗi chưa start bot" | "Đã thu hồi"`), the 🔒 confirmation line, and the ⚠️ warning line all match character-for-character including emoji, punctuation, and diacritics. Internal audit markers (`"Lỗi gửi Inbox"`, `"Lỗi thu hồi"`) are kept distinct from the three glossary statuses, as the plan intended.

The detector, config, and field mapping conform. Keyword matching normalizes with NFD + combining-mark strip + lowercase and uses word-boundary `tk`/`mk` plus `tai khoan`/`mat khau`; the numeric rule strips separators then matches 8+ digits. `loadConfig` throws naming the first missing var in `BOT_TOKEN` → `SUPABASE_URL` → `SUPABASE_KEY` order. `created_at` is the replied-to request's Unix seconds converted with `new Date(date * 1000).toISOString()`.

Test evidence is present and consistent: the plan note records the exact commands and a green summary (8 files, 71 tests), the 8 named test files exist on disk, the network is mocked everywhere, and the real bot token appears nowhere in the repo.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings.

</details>

<details>
<summary>Details</summary>

### Branch ordering on the happy and security paths

`handleUpdate` sends to the inbox first under `withTimeout(..., 10_000)`, and only on a confirmed `ok: true` does it call `deleteWithRetry`, then `insertLog("Đã gửi Inbox")`, then post the confirmation line. The security path is reached when `timedOut` is set or `sendResult.forbidden` is true, and it issues `deleteWithRetry` before `insertLog("Lỗi chưa start bot")` before the warning `sendMessage` — delete strictly before warning, matching Requirement 4.1/4.3. The 403 case and the 10s timeout case converge on the exact same block, so they behave identically (Requirement 4.5). The handler test asserts both orderings via an ordered trace, including a fake-timer test that drives the real 10,000ms boundary and confirms nothing destructive happens at 9,999ms.

A non-403, non-timeout send failure (including a bare transport rejection, since `sendMessage` normalizes its own fetch rejection to `{ ok: false, forbidden: false }`) retains the reply with no delete and logs the delivery-failure marker (Requirement 2.3). The timeout rejection is distinguished from other rejections by `instanceof TimeoutError`, so only a genuine 10s timeout takes the destructive path — a subtle correctness point the tests cover with a `getaddrinfo ENOTFOUND` rejection that must retain the reply.

### Bounded delete retries

`deleteWithRetry` defaults to 3 attempts and catches per-attempt rejections so a thrown delete does not short-circuit the budget. Both the success-path delete-exhaustion case and the 403-path delete-exhaustion case log `"Lỗi thu hồi"` and the latter posts no warning (warning stays pending), each asserted to invoke `deleteMessage` exactly 3 times.

### Byte-for-byte Vietnamese strings

Comparing the implementation against the spec text:

```
LogStatus:    "Đã gửi Inbox" | "Lỗi chưa start bot" | "Đã thu hồi"   (types.ts == requirements glossary)
confirmation: 🔒 ${ctvName} đã gửi thông tin Tài khoản / Mật khẩu vào Inbox cá nhân của QLL.
warning:      ⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox.
```

All three match the spec character-for-character, including the `⚠️` variation selector, the `🔒` and spacing around `/`, and the trailing period. The `/start` acknowledgement string (`"✅ Inbox đã sẵn sàng. ..."`) is not byte-constrained by the spec — Requirement 6.1 only requires an acknowledgement that the inbox is open — so its wording is a free choice and conforms.

### Detector, config, and field mapping

The detector normalizes with `NFD` + `/[\u0300-\u036f]/g` strip + lowercase, matches `/\b(tk|mk)\b/` and the phrases `tai khoan` / `mat khau`, then strips `/[\s.\-]/g` and tests `/\d{8,}/`. This covers the colon variants (the colon does not break the boundary match) and separated numbers, and rejects 7-digit numbers and incidental letters — matching Requirement 3 and the design's stated regexes.

`loadConfig` reads the three vars in order and throws a descriptive error naming the first missing one, satisfying Requirement 8.3. `buildLogRecord` sets `created_at` from `reply_to_message.date * 1000` via `toISOString()` (ISO UTC, Requirement 7.1), stores `qll_telegram_id` as a string, derives both names through the shared `displayName` (first+last, else first, else username, else ""), and defaults `request_content` to `""` when the replied-to message has no text (Requirement 7.4). `response_content` is `message.text` verbatim.

### Webhook idempotency and config error

`api/webhook.ts` returns 500 only when `loadConfig()` throws and otherwise always returns 200, swallowing handler errors so Telegram does not retry — matching the design's single non-200 outcome rule (Property 10).

### Test evidence and safety

The plan note at `.agents/tasks/plan.md` records `npx tsc --noEmit` PASS and `npm test` (→ `vitest run`) PASS with 8 files / 71 tests, broken down per file. All 8 named files exist on disk. Per the task scope I did not re-run the suite; the evidence is specific and internally consistent, so I accept it. The network edges are mocked throughout — `fetch` is stubbed in the telegram and integration tests, the Supabase client is mocked at the `Deps` boundary, and the webhook tests mock config/handler/telegram/supabase — so no live calls occur. A search for the real BotFather token (`8975195425…` / `AAHqFjuh24…`) returns no matches, and `.env.example` carries placeholders only.

</details>

<details>
<summary>File map</summary>

- `lib/handler.ts` — relay orchestration; branch logic and ordering reviewed in depth.
- `lib/detector.ts` — keyword + 8-digit sensitivity rules.
- `lib/config.ts` — env validation, first-missing-var error.
- `lib/types.ts` — Telegram subset types and the `LogStatus` union / `LogRecord` shape.
- `lib/mapping.ts` — `displayName` + `buildLogRecord` field mapping.
- `lib/telegram.ts` — fetch wrapper, `withTimeout`, `deleteWithRetry`.
- `lib/supabase.ts` — non-throwing `insertLog`.
- `api/webhook.ts` — HTTP boundary, 200/500 contract.
- `tests/*.test.ts` — 8 files; ordering, strings, detection, mapping, config, supabase, webhook, integration.

Full sources read directly; no diff was generated for this local review.

</details>
