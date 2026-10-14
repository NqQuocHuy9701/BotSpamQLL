# Requirements Document

## Introduction

Telegram Account Relay Bot is a serverless Telegram bot that protects sensitive account credentials (Tài khoản / Mật khẩu) shared inside a shared working group. When a collaborator (CTV) replies to a manager's (QLL) account request with credential information, the bot intercepts the message, relays the exact credential text to the manager's private inbox, removes the sensitive message from the group, logs the exchange to Supabase, and posts a non-sensitive confirmation in the group. The bot runs as a single Vercel Serverless Function (TypeScript) at `api/webhook.ts`, uses Telegram Bot API for all messaging actions, and stores shift history in a pre-existing Supabase table `bot_account_logs`. All user-facing text is Vietnamese and must be preserved exactly.

## Glossary

- **Bot**: The Telegram Account Relay Bot system, implemented as a Vercel Serverless Function at `api/webhook.ts`.
- **Webhook_Handler**: The single HTTP endpoint of the Bot that receives Telegram update payloads.
- **QLL**: Quản Lý (manager) — the group member who requests an account in the shared group and receives credentials in their private inbox.
- **CTV**: Cộng Tác Viên (collaborator) — the group member who replies with the requested credential information.
- **Shared_Group**: The Telegram group chat where QLL posts account requests and CTV replies.
- **Request_Message**: The original message sent by QLL in the Shared_Group requesting an account.
- **Reply_Message**: A Telegram reply sent by CTV in the Shared_Group that targets the QLL Request_Message.
- **Sensitive_Content**: Text that contains TK/MK keywords (including diacritic, case, and colon variants) OR a numeric string of 8 or more digits resembling a phone or account number.
- **TK_MK_Keyword**: Any of the keywords indicating account/password information, matched case-insensitively and diacritic-insensitively (e.g. "TK", "MK", "Tài khoản", "Mật khẩu", and colon-suffixed variants such as "TK:", "MK:").
- **Private_Inbox**: The one-to-one private chat between the Bot and QLL.
- **Supabase_Logger**: The component of the Bot that writes a log record to the Supabase table `bot_account_logs`.
- **Account_Logs_Table**: The pre-existing Supabase table `bot_account_logs` with columns: `id`, `created_at`, `qll_telegram_id`, `qll_name`, `request_content`, `ctv_name`, `response_content`, `status`.
- **Log_Status**: The enumerated status of a log record, one of: "Đã gửi Inbox", "Lỗi chưa start bot", "Đã thu hồi".
- **Env_Config**: The set of environment variables required by the Bot: `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`.

## Requirements

### Requirement 1: QLL Account Request Visibility

**User Story:** As a QLL, I want to post an account request in the shared group normally, so that collaborators can see and respond to the request.

#### Acceptance Criteria

1. WHEN QLL sends a Request_Message in the Shared_Group that does not contain Sensitive_Content, THE Bot SHALL leave the Request_Message visible in the Shared_Group without deletion, inbox relay, or logging.

### Requirement 2: Sensitive Reply Relay and Removal

**User Story:** As a QLL, I want sensitive credential replies to be moved out of the group and delivered to my private inbox, so that account information is never exposed in the shared group.

#### Acceptance Criteria

1. WHEN the Webhook_Handler receives a Reply_Message in the Shared_Group that contains Sensitive_Content, THE Bot SHALL send to the Private_Inbox of the QLL who authored the replied-to Request_Message, via Telegram sendMessage within 5 seconds of receipt, a message composed of the QLL Request_Message text prefixed with "📩 Yêu cầu của bạn: " followed by a blank line and then the exact Sensitive_Content text; and IF the replied-to Request_Message has no text, THEN THE Bot SHALL send only the exact Sensitive_Content text with no prefix line.
2. WHEN the Bot has confirmed successful delivery of the Sensitive_Content to the Private_Inbox, THE Bot SHALL delete the originating Reply_Message from the Shared_Group via Telegram deleteMessage within 5 seconds of the delivery confirmation.
3. IF the Telegram sendMessage call to the Private_Inbox does not return a success response, THEN THE Bot SHALL retain the Reply_Message in the Shared_Group, SHALL NOT delete the Reply_Message, and SHALL write one record to the Account_Logs_Table with a Log_Status value indicating private-inbox delivery failure.
4. IF the Telegram deleteMessage call fails after the Sensitive_Content was successfully delivered to the Private_Inbox, THEN THE Bot SHALL retry the deleteMessage call up to 3 times and, if all retries fail, SHALL write one record to the Account_Logs_Table with a Log_Status value indicating deletion failure.
5. WHEN the Bot has both successfully delivered the Sensitive_Content to the Private_Inbox and successfully deleted the Reply_Message from the Shared_Group, THE Bot SHALL write exactly one record to the Account_Logs_Table with Log_Status "Đã gửi Inbox".
6. WHEN the Bot has both successfully delivered the Sensitive_Content to the Private_Inbox and successfully deleted the Reply_Message from the Shared_Group, THE Bot SHALL post the confirmation message "🔒 [Tên CTV] đã gửi thông tin Tài khoản / Mật khẩu vào Inbox cá nhân của QLL." in the Shared_Group as a Telegram reply to the QLL Request_Message, substituting the display name of the CTV who authored the Reply_Message for [Tên CTV].
7. WHEN the Bot sends the Private_Inbox message, THE Bot SHALL include the Sensitive_Content from the Reply_Message byte-for-byte, with no truncation, reformatting, or added characters within the Sensitive_Content portion; the only text the Bot may add around it is the "📩 Yêu cầu của bạn: " prefix, the QLL Request_Message text, and the blank-line separator defined in criterion 1.

### Requirement 3: Sensitive Content Detection

**User Story:** As a QLL, I want sensitive content detected reliably across formatting variations, so that credentials are caught regardless of how the collaborator typed them.

#### Acceptance Criteria

1. WHEN the Webhook_Handler evaluates a Reply_Message, THE Bot SHALL classify the Reply_Message as containing Sensitive_Content IF the Reply_Message text contains a TK_MK_Keyword matched case-insensitively and diacritic-insensitively.
2. WHEN the Webhook_Handler evaluates a Reply_Message, THE Bot SHALL classify the Reply_Message as containing Sensitive_Content IF the Reply_Message text, after removing spaces, dashes, and dots, contains a continuous numeric string of 8 or more digits.
3. WHEN the Webhook_Handler evaluates a Reply_Message that contains neither a TK_MK_Keyword nor a numeric string of 8 or more digits (per criteria 1 and 2), THE Bot SHALL leave the Reply_Message in the Shared_Group without deletion, inbox relay, or logging.

### Requirement 4: QLL Not Started (403) Safe Handling

**User Story:** As a QLL, I want the system to behave safely when I have not started the bot, so that credentials are still removed from the group even if I cannot yet receive them privately.

#### Acceptance Criteria

1. IF the Telegram sendMessage to the Private_Inbox returns a 403 Forbidden response, THEN THE Bot SHALL delete the Reply_Message from the Shared_Group via Telegram deleteMessage before posting any warning message.
2. IF the Telegram sendMessage to the Private_Inbox returns a 403 Forbidden response, THEN THE Bot SHALL write exactly one record to the Account_Logs_Table with Log_Status "Lỗi chưa start bot".
3. IF the Telegram sendMessage to the Private_Inbox returns a 403 Forbidden response AND the Reply_Message has been deleted from the Shared_Group, THEN THE Bot SHALL post the warning message "⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox." in the Shared_Group as a Telegram reply to the QLL Request_Message.
4. IF the Telegram deleteMessage for the Reply_Message returns an error response, THEN THE Bot SHALL retry the deleteMessage up to 3 times and SHALL write one record to the Account_Logs_Table indicating the delete failure, while retaining the warning message as pending until the Reply_Message is confirmed deleted.
5. IF the Telegram sendMessage to the Private_Inbox does not return a response within 10 seconds, THEN THE Bot SHALL treat the attempt as failed and SHALL apply the same actions as a 403 Forbidden response.

### Requirement 5: Ignore Non-Reply Messages

**User Story:** As a developer, I want messages that are not replies to be ignored, so that normal group conversation is unaffected.

#### Acceptance Criteria

1. WHEN the Webhook_Handler receives a Shared_Group message that is not a reply to another message, THE Bot SHALL leave the message in the Shared_Group without deletion, inbox relay, or logging.

### Requirement 6: Private Inbox Activation via /start

**User Story:** As a QLL, I want to open my private inbox with the bot by sending /start, so that I can receive credentials privately.

#### Acceptance Criteria

1. WHEN the Webhook_Handler receives a "/start" command in a private chat with the Bot, THE Bot SHALL reply in that private chat acknowledging that the Private_Inbox is now open to receive credentials.

### Requirement 7: Supabase Shift History Logging

**User Story:** As a QLL, I want the full shift history logged accurately, so that I have a complete and auditable record of credential exchanges.

#### Acceptance Criteria

1. WHEN the Bot writes a record to the Account_Logs_Table, THE Supabase_Logger SHALL set `created_at` to the timestamp at which the original QLL Request_Message being replied to was sent, expressed in UTC.
2. WHEN the Bot writes a record to the Account_Logs_Table, THE Supabase_Logger SHALL set `qll_telegram_id` to the Telegram numeric user identifier of the QLL who authored the Request_Message.
3. WHEN the Bot writes a record to the Account_Logs_Table, THE Supabase_Logger SHALL set `qll_name` to the display name of the QLL who authored the Request_Message, where the display name is the QLL's Telegram first name concatenated with the last name when a last name is present, and IF both first name and last name are absent, THEN THE Supabase_Logger SHALL set `qll_name` to the QLL's Telegram username.
4. WHEN the Bot writes a record to the Account_Logs_Table AND the replied-to QLL Request_Message contains text, THE Supabase_Logger SHALL set `request_content` to the exact text of that Request_Message, and IF the replied-to Request_Message contains no text, THEN THE Supabase_Logger SHALL set `request_content` to an empty string.
5. WHEN the Bot writes a record to the Account_Logs_Table, THE Supabase_Logger SHALL set `ctv_name` to the display name of the CTV who authored the Reply_Message, where the display name is the CTV's Telegram first name concatenated with the last name when a last name is present, and IF both first name and last name are absent, THEN THE Supabase_Logger SHALL set `ctv_name` to the CTV's Telegram username.
6. WHEN the Bot writes a record to the Account_Logs_Table, THE Supabase_Logger SHALL set `response_content` to the exact Sensitive_Content text from the Reply_Message.
7. WHEN the Bot writes a record to the Account_Logs_Table after Sensitive_Content was successfully delivered to the Private_Inbox and the Reply_Message was deleted, THE Supabase_Logger SHALL set `status` to "Đã gửi Inbox".
8. IF the Bot writes a record to the Account_Logs_Table after the Telegram sendMessage to the Private_Inbox returned a 403 Forbidden response, THEN THE Supabase_Logger SHALL set `status` to "Lỗi chưa start bot".
9. WHEN the Bot writes a record to the Account_Logs_Table for a Sensitive_Content exchange that was subsequently withdrawn, THE Supabase_Logger SHALL set `status` to "Đã thu hồi".

### Requirement 8: Environment Variable Secrets

**User Story:** As a developer, I want all secrets supplied through environment variables, so that no credentials are hard-coded in the source.

#### Acceptance Criteria

1. THE Bot SHALL read `BOT_TOKEN`, `SUPABASE_URL`, and `SUPABASE_KEY` from Env_Config at runtime.
2. THE Bot SHALL provide a `.env.example` file enumerating `BOT_TOKEN`, `SUPABASE_URL`, and `SUPABASE_KEY`.
3. IF a required Env_Config variable is absent at runtime, THEN THE Bot SHALL return an error response from the Webhook_Handler.

### Requirement 9: Single Serverless Endpoint

**User Story:** As a developer, I want the bot delivered as a single serverless endpoint, so that deployment stays minimal and matches the chosen hosting model.

#### Acceptance Criteria

1. THE Bot SHALL expose a single HTTP endpoint implemented in TypeScript at `api/webhook.ts` as a Vercel Serverless Function.
2. WHEN the Webhook_Handler receives a Telegram update payload, THE Bot SHALL process the update within the single endpoint without a web user interface.
3. THE Bot SHALL access the Account_Logs_Table assuming the table already exists, without executing any schema migration.

### Requirement 10: Prompt Removal and Delivery

**User Story:** As a QLL, I want sensitive replies removed and delivered promptly, so that credentials are not exposed to the group for a noticeable time.

#### Acceptance Criteria

1. WHEN the Webhook_Handler receives a Reply_Message containing Sensitive_Content, THE Bot SHALL issue the deleteMessage request within 500 milliseconds of receiving the update, EXCEPT on the success path where confirmed-delivery-before-delete (Requirement 2.2) takes precedence: there the 500-millisecond target is best-effort and bounded by Telegram's own sendMessage latency, and THE Bot SHALL instead issue the deleteMessage promptly within the same webhook invocation once inbox delivery is confirmed, without additional delay. On the 403 / timeout security path, where there is no delivery to await, THE Bot SHALL issue the deleteMessage within 500 milliseconds of receiving the update.
2. WHEN the Bot sends Sensitive_Content to the Private_Inbox, THE Bot SHALL issue the sendMessage request during the same webhook invocation that processes the Reply_Message.
