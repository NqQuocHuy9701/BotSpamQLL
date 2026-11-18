export type PlannerRisk = "low" | "medium" | "high" | "unknown";

export interface ShadowPlan {
  intent: string;
  missingData: string[];
  steps: Array<{ tool: string | null; purpose: string }>;
  risk: PlannerRisk;
}

export function plannerShadowEnabled(env: Record<string, string | undefined>): boolean {
  return env.AI_PLANNER_SHADOW?.trim().toLowerCase() === "true";
}

function stringList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, max);
}

/** Parse planner output into bounded metadata. This result is descriptive only and must never execute tools. */
export function parseShadowPlan(raw: string, allowedTools: ReadonlySet<string>): ShadowPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.intent !== "string" || !Array.isArray(obj.steps)) return null;

  const steps = obj.steps
    .filter((step): step is Record<string, unknown> => !!step && typeof step === "object" && !Array.isArray(step))
    .slice(0, 6)
    .map((step) => ({
      tool: typeof step.tool === "string" && allowedTools.has(step.tool) ? step.tool : null,
      purpose: typeof step.purpose === "string" ? step.purpose.trim().slice(0, 100) : "",
    }));
  const risk: PlannerRisk = obj.risk === "low" || obj.risk === "medium" || obj.risk === "high" ? obj.risk : "unknown";

  return {
    intent: obj.intent.trim().slice(0, 120),
    missingData: stringList(obj.missing_data, 5, 100),
    steps,
    risk,
  };
}
