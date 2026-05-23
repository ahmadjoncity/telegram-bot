require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

const chatHistories = new Map();

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 Salom! Men AI botman. Savolingizni yozing!`);
});

bot.onText(/\/reset/, (msg) => {
  chatHistories.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "🔄 Suhbat tozalandi!");
});

bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!chatHistories.has(userId)) chatHistories.set(userId, []);
  const history = chatHistories.get(userId);
  history.push({ role: "user", content: msg.text });

  bot.sendChatAction(chatId, "typing");

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: history,
      max_tokens: 1024,
    });

    const reply = response.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(chatId, "⚠️ Xatolik yuz berdi, qayta urinib ko'ring.");
  }
});

console.log("🤖 Telegram bot ishga tushdi...");