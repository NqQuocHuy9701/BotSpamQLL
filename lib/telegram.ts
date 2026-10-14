// Thin typed Telegram Bot API wrapper over native fetch, plus error
// classification, a timeout helper, and bounded delete retries.

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramClient {
  sendMessage(
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): Promise<SendResult>;
  deleteMessage(chatId: number, messageId: number): Promise<DeleteResult>;
}

export type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; forbidden: boolean; description: string };

export type DeleteResult = { ok: true } | { ok: false; description: string };

export class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export function createTelegramClient(botToken: string): TelegramClient {
  const base = `${TELEGRAM_API_BASE}/bot${botToken}`;

  async function sendMessage(
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): Promise<SendResult> {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (replyToMessageId !== undefined) {
        body.reply_to_message_id = replyToMessageId;
        // Don't fail the whole send if the replied-to message was deleted.
        body.allow_sending_without_reply = true;
      }
      const response = await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        result?: { message_id: number };
        error_code?: number;
        description?: string;
      };

      if (payload.ok && payload.result) {
        return { ok: true, messageId: payload.result.message_id };
      }

      return {
        ok: false,
        forbidden: payload.error_code === 403,
        description: payload.description ?? "sendMessage failed",
      };
    } catch (error) {
      // Native fetch / JSON parsing rejected (DNS, socket, malformed body).
      // Surface as a non-forbidden transport failure so the handler can take
      // the retain path (Requirement 2.3) rather than the destructive 403 path.
      return {
        ok: false,
        forbidden: false,
        description: errorMessage(error, "sendMessage transport error"),
      };
    }
  }

  async function deleteMessage(
    chatId: number,
    messageId: number
  ): Promise<DeleteResult> {
    try {
      const response = await fetch(`${base}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        description?: string;
      };

      if (payload.ok) {
        return { ok: true };
      }

      return {
        ok: false,
        description: payload.description ?? "deleteMessage failed",
      };
    } catch (error) {
      // Normalize a rejected fetch/JSON parse into a structured failure so
      // deleteWithRetry retries instead of aborting after one attempt.
      return {
        ok: false,
        description: errorMessage(error, "deleteMessage transport error"),
      };
    }
  }

  return { sendMessage, deleteMessage };
}

// Rejects with a TimeoutError if the promise does not settle within `ms`.
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${ms}ms`));
    }, ms);

    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Retries deleteMessage up to `attempts` times (default 3) until it succeeds.
export async function deleteWithRetry(
  client: TelegramClient,
  chatId: number,
  messageId: number,
  attempts = 3
): Promise<DeleteResult> {
  let last: DeleteResult = { ok: false, description: "no attempt made" };

  for (let i = 0; i < attempts; i++) {
    try {
      last = await client.deleteMessage(chatId, messageId);
    } catch (error) {
      // A rejected attempt must not abort the retry budget; normalize it to a
      // structured failure and keep trying up to `attempts` times.
      last = { ok: false, description: errorMessage(error, "deleteMessage rejected") };
    }
    if (last.ok) {
      return last;
    }
  }

  return last;
}
