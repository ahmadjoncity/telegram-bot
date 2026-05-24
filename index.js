require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const { CohereClient } = require("cohere-ai");
const fs = require("fs");
 
// ─── Sozlamalar ────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const PAYME_MERCHANT_ID = process.env.PAYME_MERCHANT_ID || "";
const CLICK_MERCHANT_ID = process.env.CLICK_MERCHANT_ID || "";
 
const FREE_LIMIT = 5;
const PREMIUM_PRICE_UZS = 15000; // 15,000 so'm
const STARS_PRICE = 50;
 
// ─── Database ──────────────────────────────────────────────────────
const DB_FILE = "database.json";
 
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, messages: [], payments: [] }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}
 
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
 
function getUser(userId) {
  const db = loadDB();
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId, name: "", username: "",
      messageCount: 0, freeCount: 0,
      isPremium: false, premiumUntil: null,
      joinedAt: new Date().toISOString(), lastMessage: null,
    };
    saveDB(db);
  }
  return db.users[userId];
}
 
function updateUser(userId, data) {
  const db = loadDB();
  db.users[userId] = { ...db.users[userId], ...data };
  saveDB(db);
}
 
function saveMessage(userId, name, username, text, model) {
  const db = loadDB();
  if (!db.messages) db.messages = [];
  db.messages.push({
    userId, name, username,
    text: text.substring(0, 300),
    model, time: new Date().toISOString(),
  });
  if (db.messages.length > 2000) db.messages = db.messages.slice(-2000);
  saveDB(db);
}
 
function isUserPremium(userId) {
  if (userId === ADMIN_ID) return true;
  const user = getUser(userId);
  if (!user.isPremium || !user.premiumUntil) return false;
  return new Date(user.premiumUntil) > new Date();
}
 
function canUseBot(userId) {
  if (userId === ADMIN_ID) return true;
  if (isUserPremium(userId)) return true;
  const user = getUser(userId);
  return user.freeCount < FREE_LIMIT;
}
 
// ─── Bot & AI ──────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });
const cohere = new CohereClient({ token: COHERE_API_KEY });
 
const chatHistories = new Map();
const userModels = new Map();
 
// ─── /start ────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const userId = msg.from.id;
  const name = msg.from.first_name || "Do'stim";
  const username = msg.from.username || "";
  updateUser(userId, { name, username });
 
  const user = getUser(userId);
  const remaining = Math.max(0, FREE_LIMIT - user.freeCount);
  const isPrem = isUserPremium(userId);
 
  bot.sendMessage(msg.chat.id,
    `👋 Salom, *${name}*!\n\nMen AI botman 🤖\n\n${isPrem
      ? "✅ Siz *Premium* foydalanuvchisiz!"
      : `🆓 Bepul savollar: *${remaining}/${FREE_LIMIT}* ta qoldi`
    }\n\n📌 Komandalar:\n/model — AI tanlash\n/premium — Premium olish\n/reset — Suhbatni tozalash\n/help — Yordam`,
    { parse_mode: "Markdown" }
  );
});
 
// ─── /help ─────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🆘 *Yordam*\n\n✅ Imkoniyatlar:\n• Savollarga javob\n• Kod yozish\n• Tarjima\n• Tahlil\n\n🤖 AI lar:\n• Groq (Llama 3.3)\n• Cohere (Command-R)\n\n💎 Premium: /premium`,
    { parse_mode: "Markdown" }
  );
});
 
// ─── /reset ────────────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  chatHistories.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "🔄 Suhbat tozalandi!");
});
 
// ─── /model ────────────────────────────────────────────────────────
bot.onText(/\/model/, (msg) => {
  const current = userModels.get(msg.from.id) || "groq";
  bot.sendMessage(msg.chat.id, "🤖 Qaysi AI ni tanlaysiz?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🤖 Groq (Llama 3.3) ${current === "groq" ? "✅" : ""}`, callback_data: "model_groq" }],
        [{ text: `🧠 Cohere (Command-R) ${current === "cohere" ? "✅" : ""}`, callback_data: "model_cohere" }],
      ]
    }
  });
});
 
// ─── /premium ──────────────────────────────────────────────────────
bot.onText(/\/premium/, (msg) => {
  const userId = msg.from.id;
 
  if (isUserPremium(userId)) {
    const user = getUser(userId);
    const until = user.premiumUntil
      ? new Date(user.premiumUntil).toLocaleDateString("uz-UZ")
      : "Cheksiz";
    return bot.sendMessage(msg.chat.id,
      `✅ Siz allaqachon *Premium* foydalanuvchisiz!\n\n📅 Muddat: *${until}*`,
      { parse_mode: "Markdown" }
    );
  }
 
  bot.sendMessage(msg.chat.id,
    `💎 *Premium obuna — 1 oy*\n\n✅ Cheksiz savollar\n✅ Groq + Cohere AI\n✅ Tezkor javob\n\n💰 Narx: *${PREMIUM_PRICE_UZS.toLocaleString()} so'm*\n\nTo'lov usulini tanlang:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Payme orqali", callback_data: "pay_payme" }],
          [{ text: "💳 Click orqali", callback_data: "pay_click" }],
          [{ text: "⭐ Telegram Stars", callback_data: "pay_stars" }],
        ]
      }
    }
  );
});
 
// ─── Callback query ────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data = query.data;
 
  // Model tanlash
  if (data.startsWith("model_")) {
    const model = data.replace("model_", "");
    userModels.set(userId, model);
    chatHistories.delete(userId);
    const names = { groq: "🤖 Groq (Llama 3.3)", cohere: "🧠 Cohere (Command-R)" };
    bot.answerCallbackQuery(query.id, { text: `✅ ${names[model]} tanlandi!` });
    bot.sendMessage(query.message.chat.id,
      `✅ *${names[model]}* tanlandi!\nSuhbat tarixi tozalandi.`,
      { parse_mode: "Markdown" }
    );
  }
 
  // Payme to'lov
  if (data === "pay_payme") {
    bot.answerCallbackQuery(query.id);
    const paymeUrl = `https://checkout.paycom.uz/${PAYME_MERCHANT_ID}?amount=${PREMIUM_PRICE_UZS * 100}&detail.description=Premium_${userId}`;
    bot.sendMessage(query.message.chat.id,
      `💳 *Payme orqali to'lash*\n\nQuyidagi havolaga o'ting:\n${paymeUrl}\n\n✅ To'lovdan keyin /paid ni yuboring — admin tasdiqlaydi.`,
      { parse_mode: "Markdown" }
    );
  }
 
  // Click to'lov
  if (data === "pay_click") {
    bot.answerCallbackQuery(query.id);
    const clickUrl = `https://my.click.uz/services/pay?service_id=${CLICK_MERCHANT_ID}&merchant_id=${CLICK_MERCHANT_ID}&amount=${PREMIUM_PRICE_UZS}&transaction_param=${userId}`;
    bot.sendMessage(query.message.chat.id,
      `💳 *Click orqali to'lash*\n\nQuyidagi havolaga o'ting:\n${clickUrl}\n\n✅ To'lovdan keyin /paid ni yuboring — admin tasdiqlaydi.`,
      { parse_mode: "Markdown" }
    );
  }
 
  // Telegram Stars to'lov
  if (data === "pay_stars") {
    bot.answerCallbackQuery(query.id);
    await bot.sendInvoice(
      query.message.chat.id,
      "💎 Premium obuna",
      "1 oylik cheksiz foydalanish — Groq + Cohere AI",
      `premium_${userId}`,
      "XTR",
      [{ label: "1 oy Premium", amount: STARS_PRICE }]
    );
  }
 
  // Admin: Premium berish tasdiqlash
  if (data.startsWith("give_premium_") && userId === ADMIN_ID) {
    const targetId = parseInt(data.replace("give_premium_", ""));
    const until = new Date();
    until.setMonth(until.getMonth() + 1);
    updateUser(targetId, { isPremium: true, premiumUntil: until.toISOString() });
    bot.answerCallbackQuery(query.id, { text: "✅ Premium berildi!" });
    bot.editMessageText(`✅ *${targetId}* ga Premium berildi!`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown"
    });
    bot.sendMessage(targetId,
      `🎉 *Premium* faollashtirildi!\n\n✅ 1 oy cheksiz foydalanishingiz mumkin!`,
      { parse_mode: "Markdown" }
    );
  }
});
 
// ─── /paid — to'lov qilganini bildirish ───────────────────────────
bot.onText(/\/paid/, (msg) => {
  const userId = msg.from.id;
  const name = msg.from.first_name || "Noma'lum";
  const username = msg.from.username ? `@${msg.from.username}` : "yo'q";
 
  bot.sendMessage(msg.chat.id,
    `✅ To'lovingiz admin ko'rib chiqmoqda.\n\n⏳ Tez orada Premium faollashtiriladi!`
  );
 
  if (ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      `💰 *Yangi to'lov so'rovi!*\n\nIsm: *${name}*\nUsername: ${username}\nID: \`${userId}\`\n\nPremium berishni tasdiqlaysizmi?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Premium ber", callback_data: `give_premium_${userId}` }]
          ]
        }
      }
    );
  }
});
 
// ─── Telegram Stars to'lov ─────────────────────────────────────────
bot.on("pre_checkout_query", (query) => {
  bot.answerPreCheckoutQuery(query.id, true);
});
 
bot.on("successful_payment", (msg) => {
  const userId = msg.from.id;
  const until = new Date();
  until.setMonth(until.getMonth() + 1);
  updateUser(userId, { isPremium: true, premiumUntil: until.toISOString() });
 
  bot.sendMessage(msg.chat.id,
    `🎉 *To'lov qabul qilindi!*\n\n✅ Premium faollashtirildi!\n📅 Muddat: 1 oy\n\nCheksiz foydalaning! 🚀`,
    { parse_mode: "Markdown" }
  );
 
  if (ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      `⭐ *Stars to'lov!*\n\nFoydalanuvchi: ${msg.from.first_name}\nID: ${userId}\nSumma: ${STARS_PRICE} ⭐`
    );
  }
});
 
// ═══════════════════════════════════════════════════════════════════
// ─── ADMIN PANEL ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
 
// /stats — umumiy statistika
bot.onText(/\/stats/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users);
  const premiumUsers = users.filter(u => isUserPremium(u.id));
  const today = new Date().toDateString();
  const todayMsg = (db.messages || []).filter(m => new Date(m.time).toDateString() === today);
  const todayUsers = users.filter(u => u.joinedAt && new Date(u.joinedAt).toDateString() === today);
 
  bot.sendMessage(msg.chat.id,
    `📊 *Bot statistikasi*\n\n` +
    `👥 Jami foydalanuvchilar: *${users.length}*\n` +
    `💎 Premium: *${premiumUsers.length}*\n` +
    `🆓 Bepul: *${users.length - premiumUsers.length}*\n` +
    `🆕 Bugun qo'shildi: *${todayUsers.length}*\n\n` +
    `💬 Jami xabarlar: *${(db.messages || []).length}*\n` +
    `📅 Bugungi xabarlar: *${todayMsg.length}*\n\n` +
    `📌 Admin komandalar:\n` +
    `/users — foydalanuvchilar\n` +
    `/messages — oxirgi xabarlar\n` +
    `/givepremium [id] — premium berish\n` +
    `/broadcast [matn] — hammaga xabar`,
    { parse_mode: "Markdown" }
  );
});
 
// /users — foydalanuvchilar ro'yxati
bot.onText(/\/users/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users).slice(-20);
 
  if (!users.length) return bot.sendMessage(msg.chat.id, "Foydalanuvchilar yo'q.");
 
  let text = `👥 *Foydalanuvchilar (oxirgi 20):*\n\n`;
  users.forEach((u, i) => {
    const prem = isUserPremium(u.id) ? "💎" : "🆓";
    const until = u.premiumUntil ? ` (${new Date(u.premiumUntil).toLocaleDateString("uz-UZ")})` : "";
    text += `${i + 1}. ${prem} *${u.name || "Noma'lum"}*${until}\n   @${u.username || "yo'q"} | ID: \`${u.id}\` | 💬${u.messageCount || 0}\n\n`;
  });
 
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});
 
// /messages — oxirgi xabarlar
bot.onText(/\/messages/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const messages = (db.messages || []).slice(-15).reverse();
 
  if (!messages.length) return bot.sendMessage(msg.chat.id, "Xabarlar yo'q.");
 
  let text = `💬 *Oxirgi xabarlar:*\n\n`;
  messages.forEach((m, i) => {
    const time = new Date(m.time).toLocaleTimeString("uz-UZ");
    const date = new Date(m.time).toLocaleDateString("uz-UZ");
    text += `${i + 1}. *${m.name}* (@${m.username || "yo'q"})\n   🕐 ${date} ${time} | 🤖 ${m.model}\n   💬 "${m.text.substring(0, 80)}"\n\n`;
  });
 
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});
 
// /user [id] — bitta foydalanuvchi haqida
bot.onText(/\/user (.+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1]);
  if (isNaN(targetId)) return bot.sendMessage(msg.chat.id, "❌ Noto'g'ri ID!");
 
  const user = getUser(targetId);
  const db = loadDB();
  const userMessages = (db.messages || []).filter(m => m.userId === targetId);
  const isPrem = isUserPremium(targetId);
  const until = user.premiumUntil ? new Date(user.premiumUntil).toLocaleDateString("uz-UZ") : "—";
 
  bot.sendMessage(msg.chat.id,
    `👤 *Foydalanuvchi ma'lumoti*\n\n` +
    `Ism: *${user.name || "Noma'lum"}*\n` +
    `Username: @${user.username || "yo'q"}\n` +
    `ID: \`${targetId}\`\n` +
    `Status: ${isPrem ? "💎 Premium" : "🆓 Bepul"}\n` +
    `Premium muddat: ${until}\n` +
    `Jami xabarlar: *${user.messageCount || 0}*\n` +
    `Bepul ishlatdi: *${user.freeCount || 0}/${FREE_LIMIT}*\n` +
    `Saqlangan xabarlar: *${userMessages.length}*\n` +
    `Qo'shilgan: ${new Date(user.joinedAt).toLocaleDateString("uz-UZ")}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💎 Premium ber", callback_data: `give_premium_${targetId}` }]
        ]
      }
    }
  );
});
 
// /givepremium [id]
bot.onText(/\/givepremium (.+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1]);
  if (isNaN(targetId)) return bot.sendMessage(msg.chat.id, "❌ Noto'g'ri ID!");
 
  const user = getUser(targetId);
  bot.sendMessage(msg.chat.id,
    `*${user.name || targetId}* ga Premium berishni tasdiqlaysizmi?\nID: \`${targetId}\``,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Ha, Premium ber", callback_data: `give_premium_${targetId}` }]
        ]
      }
    }
  );
});
 
// /broadcast [matn]
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const text = match[1];
  const db = loadDB();
  const users = Object.values(db.users);
 
  bot.sendMessage(msg.chat.id, `📢 *${users.length}* ta foydalanuvchiga yuborilmoqda...`, { parse_mode: "Markdown" });
 
  let success = 0, failed = 0;
  for (const user of users) {
    try {
      await bot.sendMessage(user.id, `📢 *Admin xabari:*\n\n${text}`, { parse_mode: "Markdown" });
      success++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 100));
  }
 
  bot.sendMessage(msg.chat.id, `✅ Yuborildi: *${success}*\n❌ Yuborilmadi: *${failed}*`, { parse_mode: "Markdown" });
});
 
// ═══════════════════════════════════════════════════════════════════
// ─── ODDIY XABARLAR ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  if (msg.successful_payment) return;
  if (!msg.text) return bot.sendMessage(msg.chat.id, "⚠️ Faqat matnli xabarlar qabul qilinadi.");
 
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const name = msg.from.first_name || "Noma'lum";
  const username = msg.from.username || "";
  const userText = msg.text;
  const selectedModel = userModels.get(userId) || "groq";
 
  updateUser(userId, { name, username, lastMessage: new Date().toISOString() });
 
  // Limit tekshirish
  if (!canUseBot(userId)) {
    return bot.sendMessage(chatId,
      `⛔ *Bepul limitingiz tugadi!*\n\n${FREE_LIMIT} ta bepul savoldan foydalandingiz.\n\n💎 Premium oling — cheksiz foydalaning:\n/premium`,
      { parse_mode: "Markdown" }
    );
  }
 
  // Xabarni saqlash
  saveMessage(userId, name, username, userText, selectedModel);
  const user = getUser(userId);
  updateUser(userId, {
    messageCount: (user.messageCount || 0) + 1,
    freeCount: isUserPremium(userId) ? (user.freeCount || 0) : (user.freeCount || 0) + 1,
  });
 
  bot.sendChatAction(chatId, "typing");
 
  try {
    let reply = "";
    if (!chatHistories.has(userId)) chatHistories.set(userId, []);
    const history = chatHistories.get(userId);
 
    if (selectedModel === "cohere") {
      const cohereHistory = history.map(h => ({
        role: h.role === "user" ? "USER" : "CHATBOT",
        message: h.content
      }));
      const response = await cohere.chat({
        model: "command-r",
        message: userText,
        chatHistory: cohereHistory,
      });
      reply = response.text;
      history.push({ role: "user", content: userText });
      history.push({ role: "assistant", content: reply });
    } else {
      history.push({ role: "user", content: userText });
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: history,
        max_tokens: 1024,
      });
      reply = response.choices[0].message.content;
      history.push({ role: "assistant", content: reply });
    }
 
    // Qolgan bepul savollar ogohlantirishlar
    const updated = getUser(userId);
    const remaining = Math.max(0, FREE_LIMIT - updated.freeCount);
    if (!isUserPremium(userId) && remaining <= 2 && remaining > 0) {
      reply += `\n\n⚠️ _Bepul savollaringiz: ${remaining} ta qoldi!_\n_/premium — cheksiz foydalaning_`;
    }
 
    if (reply.length <= 4096) {
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    } else {
      const chunks = reply.match(/.{1,4096}/gs) || [];
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      }
    }
 
  } catch (err) {
    console.error("Xato:", err.message);
    await bot.sendMessage(chatId, "⚠️ Xatolik yuz berdi. /reset bajaring.");
  }
});
 
console.log("🤖 Telegram bot ishga tushdi...");
console.log(`👑 Admin ID: ${ADMIN_ID}`);
 
