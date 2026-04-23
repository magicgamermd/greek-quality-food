import type { Scenario, TranscriptTurn } from "../types.js";

function formatTurn(t: TranscriptTurn, i: number): string {
  switch (t.kind) {
    case "sent_to_bot":
      return `[${i}] USER → ${t.text}`;
    case "bot_reply": {
      const extras: string[] = [];
      if (t.document) {
        const kb = Math.max(1, Math.round(t.document.size / 1024));
        extras.push(
          `[FILE: "${t.document.fileName}" ${t.document.mimeType} ${kb}KB]`,
        );
      }
      if (t.buttons && t.buttons.length > 0) {
        const btns = t.buttons.map((b) => `[${b.text}]`).join(" ");
        extras.push(`[BUTTONS: ${btns}]`);
      }
      const suffix = extras.length ? ` ${extras.join(" ")}` : "";
      return `[${i}] BOT  → ${t.text}${suffix}`;
    }
    case "clicked_button":
      return `[${i}] USER clicked button "${t.buttonText}" (msg ${t.messageId})`;
    case "actor_thought":
      return `[${i}] (thought: ${t.content})`;
    case "actor_tool_call":
      return `[${i}] (tool: ${t.tool} args=${JSON.stringify(t.args)})`;
    case "timeout":
      return `[${i}] *** TIMEOUT (${t.waitedMs}ms) ***`;
    case "error":
      return `[${i}] *** ERROR: ${t.error} ***`;
  }
}

export function buildJudgePrompt(
  scenario: Scenario,
  transcript: TranscriptTurn[],
): string {
  const criteria = scenario.success_criteria
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");
  const forbidden = scenario.forbidden_behaviors.length
    ? "ЗАБРАНЕНИ ПОВЕДЕНИЯ (маркирай ако се случат):\n" +
      scenario.forbidden_behaviors.map((f) => `  - ${f}`).join("\n") +
      "\n\n"
    : "";
  const turns = transcript.map(formatTurn).join("\n") || "(празен transcript)";

  return `Ти си строг UX одитор на МЕРТ-М Telegram бота. Преглеждаш разговор между тестер и бота и вадиш обективна оценка.

СЦЕНАРИЙ: ${scenario.title}
ЦЕЛ НА ТЕСТЕРА:
${scenario.goal}

КРИТЕРИИ ЗА УСПЕХ (всички трябва да са met=true за goal_achieved="yes"):
${criteria}

${forbidden}ТРАНСКРИПТ:
${turns}

ЗАДАЧА:
Оцени строго. Всяко двойно питане за същото, всяка 500 грешка, всяко объркване — е проблем, не "минорна дреболия". Преценявай от гледна точка на реален потребител, а не на разработчик.

ОТГОВОРИ САМО С JSON (без markdown, без обяснения извън JSON-а) със следната схема:
{
  "goal_achieved": "yes" | "no" | "partial",
  "turns_used": number,
  "criteria": [{ "text": "<критерий>", "met": bool, "evidence": "турн/цитат" }],
  "frustrations": ["описание на frustrating moment"],
  "confusions": ["моменти на объркване"],
  "bot_bugs": ["technical bugs/грешки"],
  "ux_suggestions": ["конкретни подобрения"],
  "forbidden_violations": ["случаи на забранени поведения"],
  "overall_severity": "none" | "minor" | "major" | "blocker",
  "quotes": [{ "turn": number, "text": "<цитат>", "comment": "<защо е важно>" }],
  "summary": "1-2 изречения на бг"
}

ВАЖНО: turns_used = броят USER реплики в transcript-а.`;
}
