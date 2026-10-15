// Vercel Serverless Function entry point. HTTP boundary only: parse the
// Telegram update, validate config, delegate to the handler, and reply to
// Telegram quickly.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../lib/config.js";
import { handleUpdate, type Deps } from "../lib/handler.js";
import { getClient } from "../lib/supabase.js";
import { createTelegramClient } from "../lib/telegram.js";
import type { TelegramUpdate } from "../lib/types.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Validate env config first. A missing var is a hard config error (500) and
  // is the ONLY non-200 outcome.
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "configuration error",
    });
    return;
  }

  const update = parseUpdate(req.body);

  const deps: Deps = {
    telegram: createTelegramClient(config.botToken),
    supabase: getClient(config.supabaseUrl, config.supabaseKey),
    relayEnabled: config.relayEnabled,
  };

  // Always return HTTP 200 for handled message-processing outcomes so Telegram
  // does not re-deliver the same update and cause a retry storm.
  try {
    await handleUpdate(update, deps);
  } catch {
    // Swallow handled-flow errors; still acknowledge to Telegram with 200.
  }

  res.status(200).json({ ok: true });
}

function parseUpdate(body: unknown): TelegramUpdate {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as TelegramUpdate;
    } catch {
      return { update_id: 0 };
    }
  }
  if (body && typeof body === "object") {
    return body as TelegramUpdate;
  }
  return { update_id: 0 };
}
