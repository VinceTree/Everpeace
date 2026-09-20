export type AgentMode = "default" | "plan";

export interface PlanOption { label: string; description: string; }
export interface PlanQuestion { id: string; header: string; question: string; options: PlanOption[]; }
export interface PlanRequest { questions: PlanQuestion[]; }
export type PlanReviewDecision = "approve" | "continue" | "cancel";
export interface SubmittedPlan { title: string; plan: string; }

export interface PlanInteraction {
  requestInput(request: PlanRequest, signal?: AbortSignal): Promise<Record<string, string>>;
  reviewPlan(plan: SubmittedPlan, signal?: AbortSignal): Promise<PlanReviewDecision>;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

export function parsePlanRequest(value: string): PlanRequest {
  const root = parseObject(value);
  if (!Array.isArray(root.questions) || root.questions.length < 1 || root.questions.length > 3) throw new Error("Provide between one and three questions");
  const ids = new Set<string>();
  const questions = root.questions.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid plan question");
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const header = typeof item.header === "string" ? item.header.trim().slice(0, 20) : "";
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (!/^[a-z0-9_]+$/u.test(id) || id === "__cancelled" || ids.has(id) || !header || !question) throw new Error("Plan questions require unique snake_case ids, a header, and a prompt");
    ids.add(id);
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 3) throw new Error("Each question requires two or three options");
    const options = item.options.map((rawOption) => {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) throw new Error("Invalid plan option");
      const option = rawOption as Record<string, unknown>;
      const label = typeof option.label === "string" ? option.label.trim().slice(0, 80) : "";
      const description = typeof option.description === "string" ? option.description.trim().slice(0, 240) : "";
      if (!label || !description) throw new Error("Plan options require a label and description");
      return { label, description };
    });
    return { id, header, question, options };
  });
  return { questions };
}

export function parseSubmittedPlan(value: string): SubmittedPlan {
  const root = parseObject(value);
  const title = typeof root.title === "string" ? root.title.trim().slice(0, 120) : "";
  const plan = typeof root.plan === "string" ? root.plan.trim() : "";
  if (!title || !plan) throw new Error("A submitted plan requires a title and Markdown body");
  return { title, plan };
}

export const PLAN_TOOL_DEFINITIONS = [
  {
    type: "function", name: "request_user_input",
    description: "Ask one to three material planning questions. The UI adds an Other response automatically.",
    parameters: {
      type: "object", required: ["questions"], additionalProperties: false,
      properties: { questions: {
        type: "array", minItems: 1, maxItems: 3,
        items: {
          type: "object", required: ["id", "header", "question", "options"], additionalProperties: false,
          properties: {
            id: { type: "string" }, header: { type: "string" }, question: { type: "string" },
            options: {
              type: "array", minItems: 2, maxItems: 3,
              items: { type: "object", required: ["label", "description"], additionalProperties: false, properties: { label: { type: "string" }, description: { type: "string" } } },
            },
          },
        },
      } },
    },
  },
  { type: "function", name: "submit_plan", description: "Submit a decision-complete implementation plan for review.", parameters: { type: "object", properties: { title: { type: "string" }, plan: { type: "string" } }, required: ["title", "plan"], additionalProperties: false } },
] as const;

export const PLAN_INSTRUCTIONS = `You are in strict Plan mode. Inspect the real environment and produce a decision-complete implementation plan, but do not implement or mutate anything. Only read-only file, web, skill, request_user_input, and submit_plan tools are available. Ask only material questions with real alternatives, put the recommended option first and suffix its label with (Recommended), then submit the final Markdown plan for explicit approval.`;
