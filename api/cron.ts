// Vercel Cron Function. Runs every minute (see vercel.json) and drip-sends a
// small batch of queued announcements to their target group, spacing the sends
// ~15s apart so the group is never flooded. The HTTP boundary only builds the
// real deps and enforces the cron auth guard; the testable work lives in the
// exported runCron() so tests can inject a fake sleep (no real 15s wait).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../lib/config.js";
import {
  countUnsent,
  fetchNextUnsent,
  getClient,
  markSent,
} from "../lib/supabase.js";
import { createTelegramClient, type TelegramClient } from "../lib/telegram.js";
import type { SupabaseClient } from "@supabase/supabase-js";

// How many queued messages one cron run sends, and how long to wait BETWEEN
// sends. 3 sends at 15s spacing = ~30s active time per run, safely under
// Vercel's serverless limit, giving an effective ~15-20s/message throughput on
// a per-minute cron. Named so they are easy to tune and overridable in tests.
export const CRON_BATCH_SIZE = 3;
export const CRON_DELAY_MS = 15000;

// Private completion DM sent once an admin's queue is fully drained.
const COMPLETION_MESSAGE = "✅ Đã gửi xong toàn bộ danh sách vào nhóm.";

// Real sleep used in production; tests inject their own fake sleep.
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CronDeps {
  telegram: TelegramClient;
  supabase: SupabaseClient;
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
  delayMs?: number;
}

// Core drip-send logic. Fetches up to batchSize unsent rows and sends them one
// at a time (first immediately, then a delayMs wait before each subsequent
// send). A successful send is marked sent right away; a failed send is left
// unsent so the next cron run retries it. Each send+mark is isolated in its own
// try/catch so a single failure can never abort the loop. After the batch, any
// admin whose queue is now empty gets a one-time completion DM.
export async function runCron(deps: CronDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const batchSize = deps.batchSize ?? CRON_BATCH_SIZE;
  const delayMs = deps.delayMs ?? CRON_DELAY_MS;

  const { rows } = await fetchNextUnsent(deps.supabase, batchSize);
  if (rows.length === 0) {
    return; // empty queue: nothing to send
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const result = await deps.telegram.sendMessage(
        row.chat_id,
        row.message_text
      );
      if (result.ok) {
        // Only mark sent on a confirmed send; a failure retries next run.
        await markSent(deps.supabase, row.id);
      }
    } catch {
      // Swallow a single send/mark failure so the rest of the batch proceeds;
      // the row stays unsent and is retried on the next cron run.
    }
    // Wait between sends only — not after the last row.
    if (i < rows.length - 1) {
      await sleep(delayMs);
    }
  }

  // Notify each distinct admin whose queue is now fully drained.
  const adminIds = [...new Set(rows.map((r) => r.admin_id))];
  for (const adminId of adminIds) {
    try {
      const { count } = await countUnsent(deps.supabase, adminId);
      if (count === 0) {
        await deps.telegram.sendMessage(adminId, COMPLETION_MESSAGE);
      }
    } catch {
      // A completion-notice failure must not crash the cron.
    }
  }
}

// Accepts the request only when it is a genuine Vercel cron invocation. Vercel
// attaches an `x-vercel-cron` header to its cron requests; when a CRON_SECRET
// env var is set, an `Authorization: Bearer <secret>` header is also accepted.
// Anything else is ignored (still 200, but no work) to avoid abuse.
function isAuthorizedCron(req: VercelRequest): boolean {
  if (req.headers["x-vercel-cron"] !== undefined) {
    return true;
  }
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] === `Bearer ${secret}`) {
    return true;
  }
  return false;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Unauthorized callers get a 200 but trigger no sends.
  if (!isAuthorizedCron(req)) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch {
    // Even a config error returns 200 so the cron scheduler does not retry-storm.
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const deps: CronDeps = {
    telegram: createTelegramClient(config.botToken),
    supabase: getClient(config.supabaseUrl, config.supabaseKey),
  };

  // Catch everything so a single failure never crashes the cron.
  try {
    await runCron(deps);
  } catch {
    // Swallow: a failed send stays unsent and retries on the next run.
  }

  res.status(200).json({ ok: true });
}
