import { z } from "zod";

export const SendMessageArgsSchema = z.object({
  text: z.string().min(1).max(4096),
});
export const ReadLatestArgsSchema = z.object({});
export const GoalAchievedArgsSchema = z.object({
  summary: z.string().min(1),
});
export const GiveUpArgsSchema = z.object({
  reason: z.string().min(1),
});

export type ActorToolName =
  | "send_message"
  | "read_latest_reply"
  | "goal_achieved"
  | "give_up";

// Tool definitions in Anthropic tool-use schema
export const ACTOR_TOOLS = [
  {
    name: "send_message" as const,
    description:
      "Изпрати текстово съобщение към бота в Telegram. Ботът ще отговори след малко.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Съобщението което да се изпрати. Максимум 4096 chars.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "read_latest_reply" as const,
    description:
      "Прочети последния отговор на бота (ако той вече е отговорил, но още не си го получил). Обикновено не ти трябва — reply идва автоматично след send_message.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "goal_achieved" as const,
    description:
      "Обяви че целта е постигната. Подай кратко резюме на бг (1-2 изречения).",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Кратко резюме: какво постигна и как.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "give_up" as const,
    description:
      "Откажи се от целта. Обясни защо (ботът не разбра, показа грешка, зацикли и т.н.).",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Защо се отказваш.",
        },
      },
      required: ["reason"],
    },
  },
];

export function parseToolArgs(name: string, args: unknown): unknown {
  switch (name) {
    case "send_message":
      return SendMessageArgsSchema.parse(args);
    case "read_latest_reply":
      return ReadLatestArgsSchema.parse(args);
    case "goal_achieved":
      return GoalAchievedArgsSchema.parse(args);
    case "give_up":
      return GiveUpArgsSchema.parse(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
