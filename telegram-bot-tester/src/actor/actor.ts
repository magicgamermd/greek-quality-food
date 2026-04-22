import type Anthropic from "@anthropic-ai/sdk";
import type { TelegramClientHandle } from "../telegram/client.js";
import type { Persona, Scenario, TranscriptTurn } from "../types.js";
import { ACTOR_TOOLS, parseToolArgs } from "./tools.js";
import { buildActorSystemPrompt } from "./prompt.js";
import { computeCost } from "../cost.js";
import { log } from "../logger.js";

export type ActorResult = {
  transcript: TranscriptTurn[];
  endedBy: "goal_achieved" | "give_up" | "max_turns" | "error";
  endReason?: string;
  turnsUsed: number;
  costUsd: number;
};

type ActorOpts = {
  maxTurns: number;
  perTurnTimeoutMs: number;
  model: string;
  signal?: AbortSignal;
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type AnthropicMessage = {
  role: "user" | "assistant";
  content:
    | string
    | AnthropicContentBlock[]
    | Array<
        | { type: "tool_result"; tool_use_id: string; content: string }
        | { type: "text"; text: string }
      >;
};

export async function runActor(
  scenario: Scenario,
  persona: Persona,
  tg: TelegramClientHandle,
  anthropic: Anthropic,
  opts: ActorOpts,
): Promise<ActorResult> {
  const transcript: TranscriptTurn[] = [];
  let costUsd = 0;
  const systemPrompt = buildActorSystemPrompt(persona, scenario);
  const messages: AnthropicMessage[] = [
    {
      role: "user",
      content:
        "Започни да действаш към целта. Изпрати първото си съобщение или ползвай read_latest_reply ако бот-ът вече е изпратил нещо.",
    },
  ];

  let turnsUsed = 0;
  let endedBy: ActorResult["endedBy"] = "max_turns";
  let endReason: string | undefined;

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (opts.signal?.aborted) {
      transcript.push({
        kind: "error",
        at: new Date().toISOString(),
        error: "scenario cancelled",
      });
      endedBy = "error";
      endReason = "scenario_cancelled";
      break;
    }
    let response;
    try {
      response = await (
        anthropic.messages.create as unknown as (p: unknown) => Promise<{
          stop_reason: string;
          content: AnthropicContentBlock[];
          usage: { input_tokens: number; output_tokens: number };
        }>
      )({
        model: opts.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: ACTOR_TOOLS,
        messages,
      });
    } catch (err) {
      transcript.push({
        kind: "error",
        at: new Date().toISOString(),
        error: `actor anthropic error: ${String(err)}`,
      });
      endedBy = "error";
      endReason = `actor_api_error: ${String(err)}`;
      break;
    }

    costUsd += computeCost(opts.model, response.usage);

    const toolUses = response.content.filter(
      (c): c is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
        c.type === "tool_use",
    );
    const textBlocks = response.content.filter(
      (c): c is Extract<AnthropicContentBlock, { type: "text" }> =>
        c.type === "text",
    );
    for (const tb of textBlocks) {
      transcript.push({
        kind: "actor_thought",
        at: new Date().toISOString(),
        content: tb.text,
      });
    }

    if (toolUses.length === 0) {
      // No tool use — actor is thinking aloud without acting. Nudge or stop.
      transcript.push({
        kind: "error",
        at: new Date().toISOString(),
        error: "actor produced no tool_use",
      });
      endedBy = "error";
      endReason = "actor_no_tool_use";
      break;
    }

    // Build the assistant message exactly as received (preserves tool_use blocks)
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];
    let loopTerminated = false;

    for (const tu of toolUses) {
      transcript.push({
        kind: "actor_tool_call",
        at: new Date().toISOString(),
        tool: tu.name,
        args: tu.input,
      });

      let args: unknown;
      try {
        args = parseToolArgs(tu.name, tu.input);
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Грешка: ${String(err)}. Опитай отново с правилните аргументи.`,
        });
        continue;
      }

      if (tu.name === "goal_achieved") {
        endedBy = "goal_achieved";
        endReason = (args as { summary: string }).summary;
        loopTerminated = true;
        break;
      }
      if (tu.name === "give_up") {
        endedBy = "give_up";
        endReason = (args as { reason: string }).reason;
        loopTerminated = true;
        break;
      }
      if (tu.name === "send_message") {
        const text = (args as { text: string }).text;
        try {
          await tg.sendMessage(text);
        } catch (err) {
          const errStr = String(err);
          transcript.push({
            kind: "error",
            at: new Date().toISOString(),
            error: `send_message failed: ${errStr}`,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Грешка при изпращане (${errStr}). Какво правиш?`,
          });
          continue;
        }
        transcript.push({
          kind: "sent_to_bot",
          at: new Date().toISOString(),
          text,
        });
        try {
          const reply = await tg.waitForReply({
            timeoutMs: opts.perTurnTimeoutMs,
          });
          transcript.push({
            kind: "bot_reply",
            at: reply.receivedAt.toISOString(),
            text: reply.text,
            messageId: reply.messageId,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Ботът отговори: ${reply.text}`,
          });
        } catch (err) {
          const errStr = String(err);
          transcript.push({
            kind: "timeout",
            at: new Date().toISOString(),
            waitedMs: opts.perTurnTimeoutMs,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Ботът не отговори (${errStr}). Какво правиш?`,
          });
        }
        continue;
      }
      if (tu.name === "read_latest_reply") {
        try {
          const reply = await tg.waitForReply({ timeoutMs: 1000 });
          transcript.push({
            kind: "bot_reply",
            at: reply.receivedAt.toISOString(),
            text: reply.text,
            messageId: reply.messageId,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Ботът беше казал: ${reply.text}`,
          });
        } catch {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Няма нов отговор в момента.",
          });
        }
        continue;
      }
    }

    if (loopTerminated) {
      break;
    }

    turnsUsed++;
    messages.push({ role: "user", content: toolResults });
  }

  log.info("[actor] finished", { endedBy, turnsUsed, costUsd });

  return { transcript, endedBy, endReason, turnsUsed, costUsd };
}
