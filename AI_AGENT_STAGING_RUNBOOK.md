# Bee AI agent staging runbook

This runbook covers the planner, task state, and external-action approval gate. The code defaults all three flags to off. Do not enable them on the live deployment as part of this code change.

## Staging prerequisites

- Use a separate Vercel staging project and separate Supabase project. Never point staging at the Production database.
- Confirm the staging bot token cannot post to live groups. Use test groups with test accounts.
- Keep the existing AI provider, model, and billing limits unchanged.
- Deploy the candidate build to staging only after review and regression checks.

## Rollout sequence

1. Deploy with `AI_PLANNER_SHADOW=false`, `AI_TASK_STATE_ENABLED=false`, and `AI_APPROVAL_GATE_ENABLED=false`.
2. Smoke test existing commands, group handlers, and webhook behavior.
3. Enable `AI_PLANNER_SHADOW=true` in staging. Review bounded logs and confirm there are no tool calls, changed replies, or writes from planner output.
4. Enable `AI_TASK_STATE_ENABLED=true` in staging. Exercise private admin multi-tool requests, a repeated Telegram update, task expiry, a restart between turns, and a storage failure. Confirm task records contain tool names/statuses only, never prompts, arguments, or result text.
5. Enable `AI_APPROVAL_GATE_ENABLED=true` in staging. Exercise exact previews and approval for each gated action. Confirm changed case/check-in data, wrong owner/chat, expired task, duplicate approval, API failure, and group-context requests all fail closed.
6. Keep each flag off until its phase is reviewed and accepted. Any production enablement requires an explicit deployment decision after staging acceptance.

## Rollback

- Turn off `AI_APPROVAL_GATE_ENABLED` first to stop new gated previews/approvals.
- Turn off `AI_TASK_STATE_ENABLED` and `AI_PLANNER_SHADOW` to stop new task/planner work.
- Revert the deployment to the previous Vercel version if normal bot behavior regresses.
- Do not delete synthetic task rows or modify/migrate Production data during rollback. Existing rows expire logically and remain available for later inspection.

## Acceptance evidence

- Typecheck passes and the full regression suite has no new failures compared with the recorded baseline.
- Staging checks cover success, wrong owner/chat, expiry, payload/data changes, duplicate delivery, partial Telegram failure, and process restart.
- No planner/tool output reaches a group without approval; no approval by another user executes the action.
- Confirm flag values and staging database URL before any staged request; save the deployment URL and test evidence with the release review.

## Current state

The repository changes are local code and tests only. No staging project, staging credentials, Production database, or deployment target has been changed by this work.
