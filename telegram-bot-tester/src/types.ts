import { z } from "zod";

export const StyleSchema = z.object({
  verbosity: z.enum(["short", "medium", "verbose"]),
  tone: z.enum(["casual", "formal", "terse"]),
  typos: z.enum(["never", "sometimes", "often"]),
  emoji: z.enum(["never", "rare", "frequent"]),
});
export type Style = z.infer<typeof StyleSchema>;

export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  style: StyleSchema,
  example_utterances: z.array(z.string()),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const CategorySchema = z.enum([
  "orders",
  "invoices",
  "econt",
  "inventory",
  "voice",
  "error-handling",
]);
export type Category = z.infer<typeof CategorySchema>;

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: CategorySchema,
  persona: z.string().min(1),
  goal: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  forbidden_behaviors: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().default(12),
  initial_bot_command: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const TranscriptTurnSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("actor_thought"),
    at: z.string().datetime(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("actor_tool_call"),
    at: z.string().datetime(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal("sent_to_bot"),
    at: z.string().datetime(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("bot_reply"),
    at: z.string().datetime(),
    text: z.string(),
    messageId: z.number(),
  }),
  z.object({
    kind: z.literal("timeout"),
    at: z.string().datetime(),
    waitedMs: z.number(),
  }),
  z.object({
    kind: z.literal("error"),
    at: z.string().datetime(),
    error: z.string(),
  }),
]);
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const VerdictSchema = z.object({
  goal_achieved: z.enum(["yes", "no", "partial", "error"]),
  turns_used: z.number().int().nonnegative(),
  criteria: z.array(
    z.object({
      text: z.string().min(1),
      met: z.boolean(),
      evidence: z.string(),
    }),
  ),
  frustrations: z.array(z.string()),
  confusions: z.array(z.string()),
  bot_bugs: z.array(z.string()),
  ux_suggestions: z.array(z.string()),
  forbidden_violations: z.array(z.string()),
  overall_severity: z.enum(["none", "minor", "major", "blocker"]),
  quotes: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      text: z.string(),
      comment: z.string(),
    }),
  ),
  summary: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const ScenarioResultSchema = z.object({
  scenarioId: z.string().min(1),
  personaId: z.string().min(1),
  endedBy: z.enum(["goal_achieved", "give_up", "max_turns", "error"]),
  endReason: z.string().optional(),
  turnsUsed: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  transcript: z.array(TranscriptTurnSchema),
  verdict: VerdictSchema,
});
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export const RunReportSchema = z.object({
  runId: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  totalCostUsd: z.number().nonnegative(),
  scenarios: z.array(ScenarioResultSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    topFrustrations: z.array(
      z.object({ text: z.string(), count: z.number().int().nonnegative() }),
    ),
    topBotBugs: z.array(
      z.object({ text: z.string(), count: z.number().int().nonnegative() }),
    ),
  }),
});
export type RunReport = z.infer<typeof RunReportSchema>;
