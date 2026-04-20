# МЕРТ-М Склад — Telegram Bot

Telegram бот за AI асистента на МЕРТ-М склад.

## Настройка

### 1. Създай бот в Telegram

1. Отвори [@BotFather](https://t.me/BotFather) в Telegram
2. Изпрати `/newbot`
3. Име: `МЕРТ-М Склад`
4. Username: `mertm_sklad_bot` (или друг свободен)
5. Копирай токена

### 2. Намери Telegram User ID

1. Отвори [@userinfobot](https://t.me/userinfobot) в Telegram
2. Изпрати `/start`
3. Копирай твоето ID

### 3. Конфигурация

Редактирай `.env`:

```
TELEGRAM_BOT_TOKEN=<токен от BotFather>
ALLOWED_USERS=<твоето user ID>
```

Може да добавиш няколко потребителя: `ALLOWED_USERS=123456,789012`

Ако `ALLOWED_USERS` е празно — ботът е достъпен за всички.

### 4. Стартиране

```bash
npm install
npm start
```

За development (auto-restart при промени):

```bash
npm run dev
```

## Команди

- `/start` — Приветствие
- `/help` — Примерни въпроси
- `/clear` — Изчисти историята на разговора

## Как работи

1. Потребителят пише въпрос в Telegram
2. Ботът го изпраща към backend API (`/chat`)
3. AI обработва въпроса и връща отговор
4. Ботът показва отговора в чата
5. Пази история от последните 10 размени за контекст
