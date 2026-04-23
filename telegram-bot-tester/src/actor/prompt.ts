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
- send_message(text): изпраща текстово съобщение към бота
- click_inline_button(button_text): натиска inline бутон под последния отговор на бота (подай точния текст, вкл. emoji)
- read_latest_reply(): прочита последен отговор на бота (рядко нужно)
- goal_achieved(summary): обяви успех когато всички критерии са постигнати
- give_up(reason): откажи се ако бот зацикли, показва грешка, или не се разбирате

КАК ИЗГЛЕЖДА ОТГОВОРЪТ НА БОТА:
Ще видиш "Ботът отговори:" и след това един или повече от:
- "Текст: ..." — написаното от бот-а
- "Файл: \\"име.pdf\\" (mime, KB)" — прикачен документ (фактура, товарителница и т.н.)
- "Бутони: [Текст 1] [Текст 2]" — inline бутони; можеш да натиснеш с click_inline_button като подадеш ТОЧНИЯ текст между скобите

ПРАВИЛА:
1. Говори като истински потребител, не като изкуствен агент. Пиши кратко.
2. Когато видиш inline бутони и искаш един от тях — използвай click_inline_button, не пиши текста в send_message.
3. Ако ботът не разбира нещо, опитай по-ясно. Ако и след 2 опита не разбира — give_up.
4. Не измисляй данни които не ти са зададени в целта. Ако ти трябва нещо (имейл, дата), измисли реалистично (напр. "утре").
5. Когато всички критерии видимо са постигнати → goal_achieved веднага. Не продължавай "за да си сигурен". Ако критерий изисква файл — увери се че си видял "Файл: ..." в отговора.
`;
}
