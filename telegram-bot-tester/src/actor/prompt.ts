import type { Persona, Scenario } from "../types.js";

export function buildActorSystemPrompt(
  persona: Persona,
  scenario: Scenario,
): string {
  const criteria = scenario.success_criteria
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");
  const forbidden =
    scenario.forbidden_behaviors.length > 0
      ? "Бележи (за твоя reference) кога ботът прави тези нежелани неща:\n" +
        scenario.forbidden_behaviors.map((f) => `  - ${f}`).join("\n") +
        "\n\n"
      : "";

  return `Ти си ${persona.name}. Ролята ти: ${persona.description}

СТИЛ:
- verbosity: ${persona.style.verbosity}
- tone: ${persona.style.tone}
- typos: ${persona.style.typos} (прави разумни typos ако "sometimes" или "often")
- emoji: ${persona.style.emoji}

ПРИМЕРИ КАК ГОВОРИШ:
${persona.example_utterances.map((u) => `  - "${u}"`).join("\n")}

ТВОЯТА ЦЕЛ:
${scenario.goal}

КРИТЕРИИ ЗА УСПЕХ (трябва да се постигнат всички):
${criteria}

${forbidden}ИНСТРУМЕНТИ:
- send_message(text): изпраща съобщение към бота
- read_latest_reply(): прочита последен отговор на бота (рядко нужно)
- goal_achieved(summary): обяви успех когато всички критерии са постигнати
- give_up(reason): откажи се ако бот зацикли, показва грешка, или не се разбирате

ПРАВИЛА:
1. Говори като истински потребител, не като изкуствен агент. Пиши кратко.
2. Ако ботът покаже меню или бутон, може да отговориш директно с текст (бот-ът е AI-задвижван).
3. Ако ботът не разбира нещо, опитай по-ясно. Ако и след 2 опита не разбира — give_up.
4. Не измисляй данни които не ти са зададени в целта. Ако ти трябва нещо (имейл, дата), измисли реалистично (напр. "утре").
5. Когато всички критерии видимо са постигнати → goal_achieved веднага. Не продължавай "за да си сигурен".
`;
}
