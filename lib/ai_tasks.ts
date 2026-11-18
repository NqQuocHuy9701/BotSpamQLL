import { createHash, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Task-state storage for private tool workflows and gated approvals. It stays disabled
// unless AI_TASK_STATE_ENABLED=true is explicitly configured. Rows use the
// existing pending_batches table; this module never migrates it.
const TASK_ROW_BASE = 7_000_000_000_000;
const TASK_ROW_SPAN = 999_999_999_999;
const TASK_LINK_ROW_BASE = 9_000_000_000_000;
const TASK_LINK_ROW_SPAN = 999_999_999_999;
export const TASK_TTL_MS = 10 * 60_000;
const TASK_STATUSES = new Set<TaskStatus>([
  "DRAFT", "PENDING", "RUNNING", "AWAITING_INPUT", "AWAITING_APPROVAL", "APPROVED", "EXECUTING",
  "COMPLETED", "FAILED", "CANCELLED", "EXPIRED", "UNKNOWN_RESULT",
]);

export type TaskStatus =
  | "DRAFT"
  | "PENDING"
  | "RUNNING"
  | "AWAITING_INPUT"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "UNKNOWN_RESULT";

export interface AgentTask {
  kind: "agent_task";
  taskId: string;
  requestKey?: string;
  ownerUserId: number;
  ownerAdminId?: number;
  chatId: number;
  groupId?: number;
  intent: string;
  scope: string;
  plan: string[];
  stepStatuses: TaskStatus[];
  status: TaskStatus;
  approvalStatus: "not_required" | "pending" | "approved" | "rejected";
  approvalActorId?: number;
  approvalPayloadHash?: string;
  payloadHash?: string;
  executionId?: string;
  resultReference?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface NewTask {
  ownerUserId: number;
  ownerAdminId?: number;
  chatId: number;
  groupId?: number;
  intent: string;
  scope: string;
  plan: string[];
  payloadHash?: string;
  requiresApproval?: boolean;
  draft?: boolean;
  ttlMs?: number;
  requestKey?: string;
}

export interface ActiveTaskLink {
  taskId: string;
  pendingStepIndex: number;
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  DRAFT: ["AWAITING_INPUT", "AWAITING_APPROVAL", "CANCELLED", "EXPIRED"],
  PENDING: ["RUNNING", "AWAITING_INPUT", "AWAITING_APPROVAL", "CANCELLED", "EXPIRED", "FAILED"],
  RUNNING: ["AWAITING_INPUT", "AWAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"],
  AWAITING_INPUT: ["RUNNING", "CANCELLED", "EXPIRED"],
  AWAITING_APPROVAL: ["APPROVED", "CANCELLED", "EXPIRED"],
  APPROVED: ["EXECUTING", "CANCELLED", "EXPIRED"],
  EXECUTING: ["COMPLETED", "FAILED", "UNKNOWN_RESULT"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  UNKNOWN_RESULT: [],
};

export function taskStateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AI_TASK_STATE_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function hashTaskPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function taskRowId(taskId: string): number | null {
  if (!/^-[0-9]{13}$/.test(taskId)) return null;
  const rowId = Number(taskId);
  const offset = -rowId - TASK_ROW_BASE;
  return Number.isSafeInteger(rowId) && offset >= 0 && offset <= TASK_ROW_SPAN ? rowId : null;
}

function rowIdForRequest(requestKey: string): number {
  // Stable row ID makes a retried Telegram update idempotent without a schema change.
  let hash = 2166136261;
  for (let i = 0; i < requestKey.length; i++) hash = Math.imul(hash ^ requestKey.charCodeAt(i), 16777619);
  const offset = (hash >>> 0) % (TASK_ROW_SPAN + 1);
  return -(TASK_ROW_BASE + offset);
}

function taskLinkRowId(ownerUserId: number, chatId: number): number {
  const key = `${ownerUserId}:${chatId}`;
  const hash = Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 12), 16);
  return -(TASK_LINK_ROW_BASE + (hash % (TASK_LINK_ROW_SPAN + 1)));
}

function isExpired(task: AgentTask, now: Date): boolean {
  return Date.parse(task.expiresAt) <= now.getTime();
}

function scopeMatches(task: AgentTask, actorId: number, chatId: number): boolean {
  return task.ownerUserId === actorId && task.chatId === chatId && (task.groupId === undefined || task.groupId === chatId);
}

function nextUpdatedAt(current: AgentTask, now: Date): string {
  const oldTime = Date.parse(current.updatedAt);
  return new Date(Math.max(now.getTime(), Number.isFinite(oldTime) ? oldTime + 1 : now.getTime())).toISOString();
}

function isStoredTask(value: unknown): value is AgentTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<AgentTask>;
  return task.kind === "agent_task" && typeof task.taskId === "string" &&
    Number.isSafeInteger(task.ownerUserId) && Number.isSafeInteger(task.chatId) &&
    typeof task.intent === "string" && typeof task.scope === "string" &&
    Array.isArray(task.plan) && task.plan.length > 0 && task.plan.length <= 15 && task.plan.every((s) => typeof s === "string") &&
    Array.isArray(task.stepStatuses) && task.stepStatuses.length === task.plan.length && task.stepStatuses.every((s) => typeof s === "string" && TASK_STATUSES.has(s as TaskStatus)) &&
    typeof task.status === "string" && TASK_STATUSES.has(task.status as TaskStatus) &&
    typeof task.createdAt === "string" && Number.isFinite(Date.parse(task.createdAt)) &&
    typeof task.updatedAt === "string" && Number.isFinite(Date.parse(task.updatedAt)) &&
    typeof task.expiresAt === "string" && Number.isFinite(Date.parse(task.expiresAt));
}

export async function createTask(
  db: SupabaseClient,
  input: NewTask,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; task: AgentTask } | { ok: false; reason: string }> {
  if (!enabled) return { ok: false, reason: "disabled" };
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0 || !Number.isSafeInteger(input.chatId)) {
    return { ok: false, reason: "invalid_identity_or_scope" };
  }
  if (!input.intent.trim() || !input.scope.trim() || input.plan.length === 0 || input.plan.length > 8) {
    return { ok: false, reason: "invalid_task" };
  }
  if (input.requestKey !== undefined && (input.requestKey.trim() === "" || input.requestKey.length > 200)) {
    return { ok: false, reason: "invalid_request_key" };
  }
  const ttlMs = Math.min(Math.max(input.ttlMs ?? TASK_TTL_MS, 30_000), 60 * 60_000);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  // The primary key makes task IDs unique without a schema change. Collision
  // retries are bounded; task creation never overwrites another task.
  for (let attempt = 0; attempt < (input.requestKey ? 1 : 4); attempt++) {
    const id = input.requestKey ? rowIdForRequest(input.requestKey) : -(TASK_ROW_BASE + randomInt(0, TASK_ROW_SPAN + 1));
    const task: AgentTask = {
      kind: "agent_task",
      taskId: String(id),
      requestKey: input.requestKey,
      ownerUserId: input.ownerUserId,
      ownerAdminId: input.ownerAdminId,
      chatId: input.chatId,
      groupId: input.groupId,
      intent: input.intent.trim().slice(0, 80),
      scope: input.scope.trim().slice(0, 120),
      plan: input.plan.map((s) => s.trim().slice(0, 240)).filter(Boolean),
      stepStatuses: input.plan.map(() => "PENDING"),
      status: input.draft ? "DRAFT" : input.requiresApproval ? "AWAITING_APPROVAL" : "PENDING",
      approvalStatus: input.draft ? "not_required" : input.requiresApproval ? "pending" : "not_required",
      payloadHash: input.payloadHash,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    if (task.plan.length === 0) return { ok: false, reason: "invalid_task" };
    try {
      const { error } = await db.from("pending_batches").insert({ admin_id: id, items: task });
      if (!error) return { ok: true, task };
      if (error.code !== "23505") return { ok: false, reason: "storage_error" };
      if (input.requestKey) {
        try {
          const { data } = await db.from("pending_batches").select("items").eq("admin_id", id).maybeSingle();
          const existing = data?.items as AgentTask | undefined;
          if (
            existing?.kind === "agent_task" &&
            existing.requestKey === input.requestKey &&
            existing.ownerUserId === input.ownerUserId &&
            existing.chatId === input.chatId
          ) return { ok: true, task: existing };
          return { ok: false, reason: "id_allocation_failed" };
        } catch {
          return { ok: false, reason: "storage_error" };
        }
      }
    } catch {
      return { ok: false, reason: "storage_error" };
    }
  }
  return { ok: false, reason: "id_allocation_failed" };
}

export async function getTask(
  db: SupabaseClient,
  taskId: string,
  actorId: number,
  chatId: number,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; task: AgentTask } | { ok: false; reason: string }> {
  if (!enabled) return { ok: false, reason: "disabled" };
  const id = taskRowId(taskId);
  if (id === null) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await db.from("pending_batches").select("items").eq("admin_id", id).maybeSingle();
    if (error || !data?.items) return { ok: false, reason: "not_found" };
    if (!isStoredTask(data.items)) return { ok: false, reason: "not_found" };
    const task = data.items;
    if (task.taskId !== taskId || !scopeMatches(task, actorId, chatId)) {
      return { ok: false, reason: "not_found" };
    }
    if (isExpired(task, now) && !["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(task.status)) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, task };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function transitionTask(
  db: SupabaseClient,
  taskId: string,
  actorId: number,
  chatId: number,
  expectedStatus: TaskStatus,
  nextStatus: TaskStatus,
  options: { payloadHash?: string; approvalActorId?: number; executionId?: string } = {},
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; task: AgentTask } | { ok: false; reason: string }> {
  const loaded = await getTask(db, taskId, actorId, chatId, enabled, now);
  if (!loaded.ok) return loaded;
  const current = loaded.task;
  if (current.status !== expectedStatus) return { ok: false, reason: "state_conflict" };
  if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) return { ok: false, reason: "invalid_transition" };
  if (nextStatus === "APPROVED") {
    if (!Number.isSafeInteger(current.ownerAdminId) || !options.payloadHash || options.payloadHash !== current.payloadHash || options.approvalActorId !== current.ownerAdminId) {
      return { ok: false, reason: "approval_mismatch" };
    }
  }
  if (nextStatus === "EXECUTING" && current.status !== "APPROVED") return { ok: false, reason: "not_approved" };

  const updated: AgentTask = {
    ...current,
    status: nextStatus,
    approvalStatus: nextStatus === "APPROVED" ? "approved" : current.approvalStatus,
    approvalActorId: nextStatus === "APPROVED" ? options.approvalActorId : current.approvalActorId,
    approvalPayloadHash: nextStatus === "APPROVED" ? options.payloadHash : current.approvalPayloadHash,
    executionId: options.executionId ?? current.executionId,
    updatedAt: nextUpdatedAt(current, now),
  };
  const id = taskRowId(taskId);
  if (id === null) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await db.from("pending_batches")
      .update({ items: updated })
      .eq("admin_id", id)
      .eq("items->>status", expectedStatus)
      .select("items");
    if (error) return { ok: false, reason: "storage_error" };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "state_conflict" };
    return { ok: true, task: updated };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/** Append an actually selected, allowlisted tool step to a running private task. */
export async function appendTaskStep(
  db: SupabaseClient,
  taskId: string,
  actorId: number,
  chatId: number,
  toolName: string,
  allowedTools: ReadonlySet<string>,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; index: number } | { ok: false; reason: string }> {
  if (!allowedTools.has(toolName)) return { ok: false, reason: "tool_not_allowed" };
  const loaded = await getTask(db, taskId, actorId, chatId, enabled, now);
  if (!loaded.ok) return loaded;
  const task = loaded.task;
  if (task.status !== "RUNNING") return { ok: false, reason: "state_conflict" };
  if (task.plan.length >= 15 || task.plan.length !== task.stepStatuses.length) return { ok: false, reason: "step_limit" };
  const updated: AgentTask = {
    ...task,
    plan: [...task.plan, `tool:${toolName}`],
    stepStatuses: [...task.stepStatuses, "PENDING"],
    updatedAt: nextUpdatedAt(task, now),
  };
  const id = taskRowId(taskId);
  if (id === null) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await db.from("pending_batches").update({ items: updated })
      .eq("admin_id", id).eq("items->>status", "RUNNING").eq("items->>updatedAt", task.updatedAt).select("items");
    if (error) return { ok: false, reason: "storage_error" };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "state_conflict" };
    return { ok: true, index: updated.plan.length - 1 };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/** Store only a step outcome; never persist tool arguments or returned private data. */
export async function finishTaskStep(
  db: SupabaseClient,
  taskId: string,
  actorId: number,
  chatId: number,
  index: number,
  outcome: "COMPLETED" | "FAILED",
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const loaded = await getTask(db, taskId, actorId, chatId, enabled, now);
  if (!loaded.ok) return loaded;
  const task = loaded.task;
  if (task.status !== "RUNNING" || !Number.isInteger(index) || index < 0 || index >= task.plan.length || task.stepStatuses[index] !== "PENDING") {
    return { ok: false, reason: "state_conflict" };
  }
  const stepStatuses = [...task.stepStatuses];
  stepStatuses[index] = outcome;
  const updated: AgentTask = { ...task, stepStatuses, updatedAt: nextUpdatedAt(task, now) };
  const id = taskRowId(taskId);
  if (id === null) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await db.from("pending_batches").update({ items: updated })
      .eq("admin_id", id).eq("items->>status", "RUNNING").eq("items->>updatedAt", task.updatedAt).select("items");
    if (error) return { ok: false, reason: "storage_error" };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "state_conflict" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/** Mark a tool step as waiting for user input and cancel unstarted sibling steps. */
export async function awaitTaskInput(
  db: SupabaseClient,
  taskId: string,
  actorId: number,
  chatId: number,
  stepIndex: number,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; task: AgentTask } | { ok: false; reason: string }> {
  const loaded = await getTask(db, taskId, actorId, chatId, enabled, now);
  if (!loaded.ok) return loaded;
  const task = loaded.task;
  if (task.status !== "RUNNING" || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= task.plan.length || task.stepStatuses[stepIndex] !== "PENDING") {
    return { ok: false, reason: "state_conflict" };
  }
  const stepStatuses = [...task.stepStatuses];
  stepStatuses[stepIndex] = "AWAITING_INPUT";
  for (let i = stepIndex + 1; i < stepStatuses.length; i++) {
    if (stepStatuses[i] === "PENDING") stepStatuses[i] = "CANCELLED";
  }
  const updated: AgentTask = { ...task, status: "AWAITING_INPUT", stepStatuses, updatedAt: nextUpdatedAt(task, now) };
  const id = taskRowId(taskId);
  if (id === null) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await db.from("pending_batches").update({ items: updated })
      .eq("admin_id", id).eq("items->>status", "RUNNING").eq("items->>updatedAt", task.updatedAt).select("items");
    if (error) return { ok: false, reason: "storage_error" };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "state_conflict" };
    return { ok: true, task: updated };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/** Resume an awaiting-input task for its exact owner/chat and validated tool batch. */
export async function resumeTaskWithTools(
  db: SupabaseClient,
  taskId: string,
  actorId: number,
  chatId: number,
  pendingStepIndex: number,
  toolNames: string[],
  allowedTools: ReadonlySet<string>,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; task: AgentTask; stepIndexes: number[] } | { ok: false; reason: string }> {
  if (toolNames.length === 0 || toolNames.length > 3 || toolNames.some((name) => !allowedTools.has(name))) {
    return { ok: false, reason: "tool_not_allowed" };
  }
  const loaded = await getTask(db, taskId, actorId, chatId, enabled, now);
  if (!loaded.ok) return loaded;
  const current = loaded.task;
  if (current.status !== "AWAITING_INPUT" || !Number.isInteger(pendingStepIndex) || pendingStepIndex < 0 ||
      pendingStepIndex >= current.plan.length || current.stepStatuses[pendingStepIndex] !== "AWAITING_INPUT") {
    return { ok: false, reason: "state_conflict" };
  }
  const plan = [...current.plan];
  const stepStatuses = [...current.stepStatuses];
  const resumedSameTool = plan[pendingStepIndex] === `tool:${toolNames[0]}`;
  const stepIndexes: number[] = [];
  if (resumedSameTool) {
    stepStatuses[pendingStepIndex] = "PENDING";
    stepIndexes.push(pendingStepIndex);
  } else {
    stepStatuses[pendingStepIndex] = "CANCELLED";
  }
  const startAt = resumedSameTool ? 1 : 0;
  for (let i = startAt; i < toolNames.length; i++) {
    plan.push(`tool:${toolNames[i]}`);
    stepStatuses.push("PENDING");
    stepIndexes.push(plan.length - 1);
  }
  if (plan.length > 15) return { ok: false, reason: "step_limit" };
  const updated: AgentTask = { ...current, plan, stepStatuses, status: "RUNNING", updatedAt: nextUpdatedAt(current, now) };
  const id = taskRowId(taskId);
  if (id === null) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await db.from("pending_batches").update({ items: updated })
      .eq("admin_id", id).eq("items->>status", "AWAITING_INPUT").eq("items->>updatedAt", current.updatedAt).select("items");
    if (error) return { ok: false, reason: "storage_error" };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "state_conflict" };
    return { ok: true, task: updated, stepIndexes };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function saveActiveTaskLink(
  db: SupabaseClient,
  taskId: string,
  ownerUserId: number,
  chatId: number,
  pendingStepIndex: number,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const loaded = await getTask(db, taskId, ownerUserId, chatId, enabled, now);
  if (!loaded.ok) return loaded;
  if (loaded.task.status !== "AWAITING_INPUT" || loaded.task.stepStatuses[pendingStepIndex] !== "AWAITING_INPUT") {
    return { ok: false, reason: "state_conflict" };
  }
  const rowId = taskLinkRowId(ownerUserId, chatId);
  const link = {
    kind: "agent_task_link",
    ownerUserId,
    chatId,
    taskId,
    pendingStepIndex,
    expiresAt: loaded.task.expiresAt,
    updatedAt: now.toISOString(),
  };
  try {
    const { data, error } = await db.from("pending_batches").select("items").eq("admin_id", rowId).maybeSingle();
    if (error) return { ok: false, reason: "storage_error" };
    const existing = data?.items as typeof link | undefined;
    if (existing && (existing.kind !== "agent_task_link" || existing.ownerUserId !== ownerUserId || existing.chatId !== chatId)) {
      return { ok: false, reason: "scope_conflict" };
    }
    if (existing?.taskId && existing.taskId !== taskId && Date.parse(existing.expiresAt) > now.getTime()) {
      const prior = await getTask(db, existing.taskId, ownerUserId, chatId, enabled, now);
      if (prior.ok && prior.task.status === "AWAITING_INPUT") return { ok: false, reason: "active_task_exists" };
    }
    if (!existing) {
      const inserted = await db.from("pending_batches").insert({ admin_id: rowId, items: link });
      if (inserted.error) return { ok: false, reason: inserted.error.code === "23505" ? "state_conflict" : "storage_error" };
      return { ok: true };
    }
    const { data: updated, error: updateError } = await db.from("pending_batches").update({ items: link })
      .eq("admin_id", rowId).eq("items->>kind", "agent_task_link")
      .eq("items->>ownerUserId", ownerUserId).eq("items->>chatId", chatId)
      .eq("items->>taskId", existing.taskId).eq("items->>updatedAt", existing.updatedAt).select("items");
    if (updateError) return { ok: false, reason: "storage_error" };
    return Array.isArray(updated) && updated.length === 1 ? { ok: true } : { ok: false, reason: "state_conflict" };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function getActiveTaskLink(
  db: SupabaseClient,
  ownerUserId: number,
  chatId: number,
  enabled = taskStateEnabled(),
  now = new Date()
): Promise<{ ok: true; link: ActiveTaskLink } | { ok: false; reason: string }> {
  if (!enabled || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || !Number.isSafeInteger(chatId)) {
    return { ok: false, reason: "disabled_or_invalid_scope" };
  }
  try {
    const { data, error } = await db.from("pending_batches").select("items")
      .eq("admin_id", taskLinkRowId(ownerUserId, chatId)).maybeSingle();
    if (error || !data?.items) return { ok: false, reason: "not_found" };
    const value = data.items as Record<string, unknown>;
    if (value.kind !== "agent_task_link" || value.ownerUserId !== ownerUserId || value.chatId !== chatId ||
        typeof value.taskId !== "string" || !Number.isInteger(value.pendingStepIndex) ||
        typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now.getTime()) {
      return { ok: false, reason: "not_found" };
    }
    const loaded = await getTask(db, value.taskId, ownerUserId, chatId, enabled, now);
    if (!loaded.ok || loaded.task.status !== "AWAITING_INPUT" || loaded.task.stepStatuses[value.pendingStepIndex as number] !== "AWAITING_INPUT") {
      return { ok: false, reason: loaded.ok ? "state_conflict" : loaded.reason };
    }
    return { ok: true, link: { taskId: value.taskId, pendingStepIndex: value.pendingStepIndex as number } };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function clearActiveTaskLink(
  db: SupabaseClient,
  taskId: string,
  ownerUserId: number,
  chatId: number,
  enabled = taskStateEnabled()
): Promise<boolean> {
  if (!enabled || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || !Number.isSafeInteger(chatId)) return false;
  const rowId = taskLinkRowId(ownerUserId, chatId);
  try {
    const { data, error } = await db.from("pending_batches").select("items").eq("admin_id", rowId).maybeSingle();
    if (error || !data?.items) return false;
    const current = data.items as Record<string, unknown>;
    if (current.kind !== "agent_task_link" || current.ownerUserId !== ownerUserId || current.chatId !== chatId || current.taskId !== taskId) return false;
    const { data: updated, error: updateError } = await db.from("pending_batches").update({
      items: { kind: "agent_task_link", ownerUserId, chatId, taskId: "", pendingStepIndex: -1, expiresAt: new Date(0).toISOString(), updatedAt: new Date().toISOString() },
    }).eq("admin_id", rowId).eq("items->>kind", "agent_task_link")
      .eq("items->>ownerUserId", ownerUserId).eq("items->>chatId", chatId)
      .eq("items->>taskId", taskId).eq("items->>updatedAt", current.updatedAt).select("items");
    return !updateError && Array.isArray(updated) && updated.length === 1;
  } catch {
    return false;
  }
}
