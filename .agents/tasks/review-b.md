# Hardened relay failure handling with remaining coverage gaps

The follow-up distinguishes true ten-second timeouts from immediate transport failures, normalizes rejected Telegram calls, and expands the mocked Vitest matrix to 71 cases. Previously missing 403 delete-exhaustion and explicit-empty mapping cases are now covered, and the timeout test exercises the real 10,000 ms boundary. Two behavioral requirements remain unproved, and the required second source of green-suite evidence is absent.

Watch for: **confirmed** the “500 ms” test does not establish deletion within 500 ms of webhook receipt; **confirmed** detector negatives never exercise `tk` or `mk` embedded contiguously inside a larger word; **confirmed** the coder final message containing the exact verification commands and result summary is unavailable.

**Verdict**: NEEDS_CHANGES

## High-level view

The failure-path fixes close the substantive defects raised previously. `TimeoutError` alone enters the destructive 403-equivalent path, other rejected sends retain the group reply, and rejected delete attempts consume the same bounded three-attempt budget as structured Telegram failures. Handler tests drive the actual timeout boundary and cover delete exhaustion on both successful-delivery and 403 paths.

The requested matrix otherwise covers keyword/separator positives, seven-digit and plain-chat negatives, mapping fallbacks, absent and explicit-empty request text, each missing config variable, Telegram response and retry outcomes, non-throwing Supabase errors, handler happy/error/ignore/`/start` branches, and webhook 200/500 responses. Call traces pin the critical ordering, while exact assertions protect the prescribed Vietnamese confirmation, warning, and status strings.

External effects are isolated: wrapper and integration tests stub `fetch`; handler tests inject fake Telegram and Supabase clients; webhook tests mock config, handler, and client construction; integration tests replace Supabase client creation. A repository search found no supplied BotFather token, and `.env.example` contains placeholders only.

The timing case advances 300 ms with delivery pending, resolves delivery manually, then checks that delete follows. **Confirmed:** it neither asserts receipt-to-delete elapsed time nor covers a successful response after 500 ms, so the send-before-delete implementation can violate Requirement 10.1 while remaining green.

The negative detector fixtures labeled as incidental letters contain neither contiguous `tk` nor contiguous `mk`. **Confirmed:** replacing the boundary-aware detector with `/tk|mk/` would still pass every current negative.

`.agents/tasks/plan.md` records exact PASS evidence for `npx tsc --noEmit` and `npm test` with 8 files and 71 tests. **Confirmed:** no coder final message carrying the same commands and summary appears in the delegation or persisted task files, so the required two-source confirmation is incomplete.

<details>
<summary>Issues (3)</summary>

1. **500 ms removal SLA remains unproved** — **confirmed:** the test proves delete follows a manually completed send, not that deletion occurs within 500 ms of webhook receipt. Resolve the conflict between confirmed-delivery-first and the receipt-relative deadline, then assert the selected contract with elapsed-time coverage.
2. **Embedded `tk`/`mk` negatives are missing** — **confirmed:** current incidental-letter fixtures contain neither contiguous token. Add larger-word fixtures such as `notksecret` and `somkvalue` so an unbounded `/tk|mk/` regression fails.
3. **Coder-final verification evidence is absent** — **confirmed:** the plan has both exact commands and the 8-file/71-test PASS summary, but the separately required coder final message is unavailable. Relay or persist that final output before accepting the green-suite claim.

</details>

<details>
<summary>Details</summary>

### The 500 ms test does not prove the receipt-relative deadline

**Confirmed:** `handleUpdate` waits for inbox delivery before deletion, and the new test manually resolves delivery after advancing fake time by 300 ms. Its final assertions check call position and count, not elapsed time from webhook receipt. A send resolving at 501 ms or nine seconds follows the same code while missing Requirement 10.1.

Confirmed-delivery-before-delete and deletion within 500 ms of receipt cannot both be guaranteed when Telegram takes longer than 500 ms. Choose which contract has precedence, then test the actual deadline or document the send-before-delete exception rather than naming an ordering-only test as SLA proof.

### Detector negatives do not protect short-token boundaries

**Confirmed:** `booktok`, `milkman`, and `attack` contain no contiguous `tk` or `mk`. Add fixtures such as `notksecret` and `somkvalue`; these remain non-sensitive under `\b(tk|mk)\b` but fail if the detector regresses to substring matching.

### Verification lacks the required coder-final source

**Confirmed:** `.agents/tasks/plan.md` records `npx tsc --noEmit` as PASS/exit 0 and `npm test` (`vitest run`) as 8 files, 71 tests, all green; the per-file counts sum to 71. This review did not rerun installation, typecheck, or the full suite.

The instruction requires the same exact commands and summary in the coder final message. The plan’s statement that one exists is not that message; relay or persist the actual output to complete verification.

</details>

<details>
<summary>File map</summary>

- `.agents/tasks/plan.md` — iteration-two verification claim and addressed findings.
- `lib/handler.ts` — separates true timeout from transport rejection.
- `lib/telegram.ts` — normalizes transport errors and bounds delete retries.
- `tests/handler.test.ts` — timeout, transport rejection, 403 exhaustion, and timing coverage.
- `tests/telegram.test.ts` — rejected-fetch and rejected-retry coverage.
- `tests/mapping.test.ts` — explicit-empty request coverage.
- `tests/detector.test.ts` — detection matrix with the remaining embedded-token gap.
- `tests/config.test.ts`, `tests/supabase.test.ts`, `tests/webhook.test.ts`, `tests/integration.test.ts` — mocked config, persistence, HTTP, and end-to-end boundaries.

Full diff: `git diff 9477770 4c76bd3 --`.

</details>
