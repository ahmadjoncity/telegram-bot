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

const FREE_DAYS = 20;                    // 20 kun bepul
const PREMIUM_PRICE_UZS = 15000;
const STARS_PRICE = 50;
const REQUIRED_CHANNEL = "@ustozaka_ai"; // Obuna kerak kanal

// ─── Database ──────────────────────────────────────────────────────
const DB_FILE = "database.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, messages: [], payments: [] }));
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE)); }
  catch { return { users: {}, messages: [], payments: [] }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getUser(userId) {
  const db = loadDB();
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId, name: "", username: "",
      messageCount: 0,
      isPremium: false, premiumUntil: null,
      joinedAt: new Date().toISOString(),
      lastMessage: null, isSubscribed: false,
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
  db.messages.push({ userId, name, username, text: text.substring(0, 300), model, time: new Date().toISOString() });
  if (db.messages.length > 2000) db.messages = db.messages.slice(-2000);
  saveDB(db);
}

function isUserPremium(userId) {
  if (userId === ADMIN_ID) return true;
  const user = getUser(userId);
  if (!user.isPremium || !user.premiumUntil) return false;
  return new Date(user.premiumUntil) > new Date();
}

// 20 kunlik bepul muddat tekshirish
function isInFreePeriod(userId) {
  if (userId === ADMIN_ID) return true;
  const user = getUser(userId);
  if (!user.joinedAt) return false;
  const joinDate = new Date(user.joinedAt);
  const now = new Date();
  const diffDays = (now - joinDate) / (1000 * 60 * 60 * 24);
  return diffDays <= FREE_DAYS;
}

function canUseBot(userId) {
  if (userId === ADMIN_ID) return true;
  if (isUserPremium(userId)) return true;
  if (isInFreePeriod(userId)) return true;
  return false;
}

// ─── Bot & AI ──────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });
const cohere = new CohereClient({ token: COHERE_API_KEY });
const chatHistories = new Map();
const userModels = new Map();

// ─── Obuna tekshirish ──────────────────────────────────────────────
async function checkSubscription(userId) {
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// ─── Asosiy Menu ───────────────────────────────────────────────────
function getMainMenu(userId) {
  const isPrem = isUserPremium(userId);
  const daysLeft = Math.max(0, FREE_DAYS - Math.floor((new Date() - new Date(getUser(userId).joinedAt)) / (1000 * 60 * 60 * 24)));

  return {
    keyboard: [
      [{ text: "🤖 AI bilan suhbat" }, { text: "⚙️ AI tanlash" }],
      [{ text: "📋 Vazifalar" }, { text: "📊 Mening hisobim" }],
      [{ text: isPrem ? "💎 Premium (Faol)" : "💎 Premium olish" }, { text: "ℹ️ Yordam" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

// ─── /start ────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const name = msg.from.first_name || "Do'stim";
  const username = msg.from.username || "";

  updateUser(userId, { name, username });

  // Obuna tekshirish
  const isSubscribed = await checkSubscription(userId);
  if (!isSubscribed) {
    return bot.sendMessage(userId,
      `👋 Salom, *${name}*!\n\n` +
      `🤖 *Ustoz AI* botiga xush kelibsiz!\n\n` +
      `⚠️ Botdan foydalanish uchun avval kanalimizga obuna bo'ling:\n\n` +
      `📢 ${REQUIRED_CHANNEL}\n\n` +
      `Obuna bo'lgach, ✅ *Tekshirish* tugmasini bosing!`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Kanalga o'tish", url: `https://t.me/${REQUIRED_CHANNEL.replace("@", "")}` }],
            [{ text: "✅ Obunani tekshirish", callback_data: "check_subscription" }]
          ]
        }
      }
    );
  }

  updateUser(userId, { isSubscribed: true });
  const user = getUser(userId);
  const isPrem = isUserPremium(userId);
  const daysLeft = Math.max(0, FREE_DAYS - Math.floor((new Date() - new Date(user.joinedAt)) / (1000 * 60 * 60 * 24)));

  bot.sendMessage(userId,
    `👋 Salom, *${name}*! Xush kelibsiz! 🎉\n\n` +
    `${isPrem ? "💎 Siz *Premium* foydalanuvchisiz!" : `🆓 Bepul muddat: *${daysLeft} kun* qoldi`}\n\n` +
    `Quyidagi menyudan foydalaning 👇`,
    { parse_mode: "Markdown", reply_markup: getMainMenu(userId) }
  );
});

// ─── Callback Query ────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data = query.data;

  // Obuna tekshirish
  if (data === "check_subscription") {
    const isSubscribed = await checkSubscription(userId);
    if (isSubscribed) {
      updateUser(userId, { isSubscribed: true });
      bot.answerCallbackQuery(query.id, { text: "✅ Obuna tasdiqlandi!" });
      bot.deleteMessage(query.message.chat.id, query.message.message_id);
      const name = query.from.first_name || "Do'stim";
      const user = getUser(userId);
      const daysLeft = Math.max(0, FREE_DAYS - Math.floor((new Date() - new Date(user.joinedAt)) / (1000 * 60 * 60 * 24)));
      bot.sendMessage(userId,
        `✅ Rahmat! Obuna tasdiqlandi!\n\n🎉 Botga xush kelibsiz!\n🆓 Bepul muddat: *${daysLeft} kun*\n\nMenyudan foydalaning 👇`,
        { parse_mode: "Markdown", reply_markup: getMainMenu(userId) }
      );
    } else {
      bot.answerCallbackQuery(query.id, { text: "❌ Siz hali obuna bo'lmadingiz!", show_alert: true });
    }
    return;
  }

  // Model tanlash
  if (data.startsWith("model_")) {
    const model = data.replace("model_", "");
    userModels.set(userId, model);
    chatHistories.delete(userId);
    const names = { groq: "🤖 Groq (Llama 3.3)", cohere: "🧠 Cohere" };
    bot.answerCallbackQuery(query.id, { text: `✅ ${names[model]} tanlandi!` });
    bot.sendMessage(query.message.chat.id, `✅ *${names[model]}* tanlandi!`, { parse_mode: "Markdown" });
    return;
  }

  // To'lov - Payme
  if (data === "pay_payme") {
    bot.answerCallbackQuery(query.id);
    const paymeUrl = `https://checkout.paycom.uz/${PAYME_MERCHANT_ID}?amount=${PREMIUM_PRICE_UZS * 100}&detail.description=Premium_${userId}`;
    bot.sendMessage(query.message.chat.id,
      `💳 *Payme orqali to'lash*\n\n👇 Havolaga o'ting:\n${paymeUrl}\n\n✅ To'lovdan keyin /paid yuboring!`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // To'lov - Click
  if (data === "pay_click") {
    bot.answerCallbackQuery(query.id);
    const clickUrl = `https://my.click.uz/services/pay?service_id=${CLICK_MERCHANT_ID}&merchant_id=${CLICK_MERCHANT_ID}&amount=${PREMIUM_PRICE_UZS}&transaction_param=${userId}`;
    bot.sendMessage(query.message.chat.id,
      `💳 *Click orqali to'lash*\n\n👇 Havolaga o'ting:\n${clickUrl}\n\n✅ To'lovdan keyin /paid yuboring!`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // To'lov - Stars
  if (data === "pay_stars") {
    bot.answerCallbackQuery(query.id);
    await bot.sendInvoice(query.message.chat.id,
      "💎 Premium obuna", "1 oylik cheksiz foydalanish",
      `premium_${userId}`, "XTR",
      [{ label: "1 oy Premium", amount: STARS_PRICE }]
    );
    return;
  }

  // Admin: Premium berish
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
    bot.sendMessage(targetId, `🎉 *Premium* faollashtirildi!\n\n✅ 1 oy cheksiz foydalaning!`, { parse_mode: "Markdown" });
    return;
  }
});

// ─── Tugmalar ──────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text) return handleMedia(msg);
  const userId = msg.from.id;
  const text = msg.text;

  // Komandalar
  if (text.startsWith("/")) return;

  // Obuna tekshirish
  if (userId !== ADMIN_ID) {
    const isSubscribed = await checkSubscription(userId);
    if (!isSubscribed) {
      return bot.sendMessage(userId,
        `⚠️ Botdan foydalanish uchun kanalga obuna bo'ling:\n\n📢 ${REQUIRED_CHANNEL}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📢 Kanalga o'tish", url: `https://t.me/${REQUIRED_CHANNEL.replace("@", "")}` }],
              [{ text: "✅ Obunani tekshirish", callback_data: "check_subscription" }]
            ]
          }
        }
      );
    }
  }

  // Limit tekshirish
  if (!canUseBot(userId)) {
    return bot.sendMessage(userId,
      `⛔ *Bepul muddat tugadi!*\n\n${FREE_DAYS} kunlik bepul foydalanish muddati tugadi.\n\n💎 Premium oling — cheksiz foydalaning!\n/premium`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Tugmalar ──
  if (text === "📋 Vazifalar") return showTasks(msg);
  if (text === "📊 Mening hisobim") return showProfile(msg);
  if (text === "⚙️ AI tanlash") return showModelSelect(msg);
  if (text === "💎 Premium olish" || text === "💎 Premium (Faol)") return showPremium(msg);
  if (text === "ℹ️ Yordam") return showHelp(msg);
  if (text === "🤖 AI bilan suhbat") {
    return bot.sendMessage(userId, "💬 Yaxshi! Savolingizni yozing, javob beraman!", { reply_markup: getMainMenu(userId) });
  }

  // AI ga savol
  await handleAIMessage(msg);
});

// ─── Vazifalar menyusi ─────────────────────────────────────────────
function showTasks(msg) {
  bot.sendMessage(msg.chat.id,
    `📋 *Vazifalar ro'yxati*\n\nQuyidagi vazifalardan birini tanlang:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✍️ Matn yozish", callback_data: "task_write" }],
          [{ text: "🌐 Tarjima qilish", callback_data: "task_translate" }],
          [{ text: "💻 Kod yozish", callback_data: "task_code" }],
          [{ text: "📝 Xulosa chiqarish", callback_data: "task_summary" }],
          [{ text: "🧮 Matematik masala", callback_data: "task_math" }],
          [{ text: "💡 Fikr berish", callback_data: "task_idea" }],
          [{ text: "📖 Tushuntirish", callback_data: "task_explain" }],
          [{ text: "🔙 Orqaga", callback_data: "task_back" }],
        ]
      }
    }
  );
}

// Vazifa callback
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data = query.data;

  const taskMessages = {
    task_write: "✍️ *Matn yozish*\n\nQanday matn yozib berishimni xohlaysiz? Menga aytib bering!\n\nMasalan: 'Tabiat haqida she'r yoz' yoki 'Rezyume yozib ber'",
    task_translate: "🌐 *Tarjima*\n\nQaysi matni qaysi tilga tarjima qilishimni xohlaysiz?\n\nMasalan: 'Hello world — o'zbekchaga tarjima qil'",
    task_code: "💻 *Kod yozish*\n\nQanday dastur yoki kod yozib berishimni xohlaysiz?\n\nMasalan: 'Python da kalkulyator yoz'",
    task_summary: "📝 *Xulosa chiqarish*\n\nMatningizni yuboring — qisqa xulosa chiqarib beraman!",
    task_math: "🧮 *Matematik masala*\n\nMasalangizni yozing — yechib beraman!\n\nMasalan: '2x + 5 = 15, x ni top'",
    task_idea: "💡 *Fikr berish*\n\nQaysi mavzuda fikr yoki tavsiya kerak?\n\nMasalan: 'Biznes g'oyalar ber' yoki 'Kino tavsiya qil'",
    task_explain: "📖 *Tushuntirish*\n\nNimani tushuntirishimni xohlaysiz?\n\nMasalan: 'Sun'iy intellekt nima' yoki 'Blockchain tushuntir'",
  };

  if (taskMessages[data]) {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(query.message.chat.id, taskMessages[data], { parse_mode: "Markdown" });
    return;
  }

  if (data === "task_back") {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(query.message.chat.id, "🏠 Asosiy menyu", { reply_markup: getMainMenu(userId) });
    return;
  }
});

// ─── Profil ko'rish ────────────────────────────────────────────────
function showProfile(msg) {
  const userId = msg.from.id;
  const user = getUser(userId);
  const isPrem = isUserPremium(userId);
  const joinDate = new Date(user.joinedAt).toLocaleDateString("uz-UZ");
  const daysLeft = Math.max(0, FREE_DAYS - Math.floor((new Date() - new Date(user.joinedAt)) / (1000 * 60 * 60 * 24)));
  const until = user.premiumUntil ? new Date(user.premiumUntil).toLocaleDateString("uz-UZ") : "—";
  const currentModel = userModels.get(userId) || "groq";

  bot.sendMessage(msg.chat.id,
    `📊 *Mening hisobim*\n\n` +
    `👤 Ism: *${user.name || "Noma'lum"}*\n` +
    `🆔 ID: \`${userId}\`\n` +
    `📅 Qo'shilgan: *${joinDate}*\n\n` +
    `${isPrem
      ? `💎 Status: *Premium*\n📅 Muddat: *${until}*`
      : `🆓 Status: *Bepul*\n⏰ Qoldi: *${daysLeft} kun*`
    }\n\n` +
    `💬 Jami xabarlar: *${user.messageCount || 0}*\n` +
    `🤖 Joriy AI: *${currentModel === "groq" ? "Groq (Llama)" : "Cohere"}*`,
    { parse_mode: "Markdown" }
  );
}

// ─── AI tanlash ────────────────────────────────────────────────────
function showModelSelect(msg) {
  const current = userModels.get(msg.from.id) || "groq";
  bot.sendMessage(msg.chat.id, "🤖 Qaysi AI ni tanlaysiz?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🤖 Groq (Llama 3.3) ${current === "groq" ? "✅" : ""}`, callback_data: "model_groq" }],
        [{ text: `🧠 Cohere ${current === "cohere" ? "✅" : ""}`, callback_data: "model_cohere" }],
      ]
    }
  });
}

// ─── Premium ───────────────────────────────────────────────────────
function showPremium(msg) {
  const userId = msg.from.id;
  if (isUserPremium(userId)) {
    const user = getUser(userId);
    const until = user.premiumUntil ? new Date(user.premiumUntil).toLocaleDateString("uz-UZ") : "Cheksiz";
    return bot.sendMessage(msg.chat.id,
      `💎 Siz allaqachon *Premium* foydalanuvchisiz!\n\n📅 Muddat: *${until}*`,
      { parse_mode: "Markdown" }
    );
  }

  bot.sendMessage(msg.chat.id,
    `💎 *Premium obuna — 1 oy*\n\n` +
    `✅ Cheksiz savollar\n` +
    `✅ Groq + Cohere AI\n` +
    `✅ Tezkor javob\n\n` +
    `💰 Narx: *${PREMIUM_PRICE_UZS.toLocaleString()} so'm*\n\n` +
    `To'lov usulini tanlang:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Payme", callback_data: "pay_payme" }],
          [{ text: "💳 Click", callback_data: "pay_click" }],
          [{ text: "⭐ Telegram Stars", callback_data: "pay_stars" }],
        ]
      }
    }
  );
}

// ─── Yordam ────────────────────────────────────────────────────────
function showHelp(msg) {
  bot.sendMessage(msg.chat.id,
    `ℹ️ *Yordam*\n\n` +
    `🤖 *AI bilan suhbat* — AI ga savol bering\n` +
    `⚙️ *AI tanlash* — Groq yoki Cohere\n` +
    `📋 *Vazifalar* — Tayyor vazifalar\n` +
    `📊 *Hisobim* — Profil va statistika\n` +
    `💎 *Premium* — Cheksiz foydalanish\n\n` +
    `📢 Kanal: ${REQUIRED_CHANNEL}\n\n` +
    `❓ Muammo bo'lsa /reset bajaring`,
    { parse_mode: "Markdown" }
  );
}

// ─── /reset ────────────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  chatHistories.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "🔄 Suhbat tozalandi!", { reply_markup: getMainMenu(msg.from.id) });
});

// ─── /premium ──────────────────────────────────────────────────────
bot.onText(/\/premium/, (msg) => showPremium(msg));

// ─── /paid ─────────────────────────────────────────────────────────
bot.onText(/\/paid/, (msg) => {
  const userId = msg.from.id;
  const name = msg.from.first_name || "Noma'lum";
  const username = msg.from.username ? `@${msg.from.username}` : "yo'q";

  bot.sendMessage(msg.chat.id, `✅ To'lovingiz admin ko'rib chiqmoqda. Tez orada Premium faollashtiriladi!`);

  if (ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      `💰 *Yangi to'lov so'rovi!*\n\nIsm: *${name}*\nUsername: ${username}\nID: \`${userId}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "✅ Premium ber", callback_data: `give_premium_${userId}` }]]
        }
      }
    );
  }
});

// ─── Stars to'lov ──────────────────────────────────────────────────
bot.on("pre_checkout_query", (query) => bot.answerPreCheckoutQuery(query.id, true));

bot.on("successful_payment", (msg) => {
  const userId = msg.from.id;
  const until = new Date();
  until.setMonth(until.getMonth() + 1);
  updateUser(userId, { isPremium: true, premiumUntil: until.toISOString() });
  bot.sendMessage(msg.chat.id, `🎉 *Premium faollashtirildi!*\n\n✅ 1 oy cheksiz foydalaning! 🚀`, { parse_mode: "Markdown" });
  if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `⭐ Yangi Stars to'lov!\nFoydalanuvchi: ${msg.from.first_name}\nID: ${userId}`);
});

// ─── AI xabar ─────────────────────────────────────────────────────
async function handleAIMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const name = msg.from.first_name || "Noma'lum";
  const username = msg.from.username || "";
  const userText = msg.text;
  const selectedModel = userModels.get(userId) || "groq";

  updateUser(userId, { name, username, lastMessage: new Date().toISOString() });
  saveMessage(userId, name, username, userText, selectedModel);
  const user = getUser(userId);
  updateUser(userId, { messageCount: (user.messageCount || 0) + 1 });

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
        model: "command-a-03-2025",
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

    // Bepul muddat ogohlantirishlar
    if (!isUserPremium(userId)) {
      const daysLeft = Math.max(0, FREE_DAYS - Math.floor((new Date() - new Date(getUser(userId).joinedAt)) / (1000 * 60 * 60 * 24)));
      if (daysLeft <= 3 && daysLeft > 0) {
        reply += `\n\n⚠️ _Bepul muddatingiz: ${daysLeft} kun qoldi!_\n_/premium — cheksiz foydalaning_`;
      }
    }

    if (reply.length <= 4096) {
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    } else {
      const chunks = reply.match(/.{1,4096}/gs) || [];
      for (const chunk of chunks) await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Xato:", err.message);
    await bot.sendMessage(chatId, "⚠️ Xatolik yuz berdi. /reset bajaring.", { reply_markup: getMainMenu(userId) });
  }
}

// ─── Rasm/Video handler ────────────────────────────────────────────
async function handleMedia(msg) {
  if (msg.from.id !== ADMIN_ID) return;

  const db = loadDB();
  const users = Object.values(db.users);

  // Rasm yuborish
  if (msg.photo && msg.caption && msg.caption.startsWith("/sendphoto")) {
    const text = msg.caption.replace("/sendphoto", "").trim();
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    bot.sendMessage(msg.chat.id, `🖼 *${users.length}* ta foydalanuvchiga yuborilmoqda...`, { parse_mode: "Markdown" });
    let success = 0, failed = 0;
    for (const user of users) {
      try {
        await bot.sendPhoto(user.id, photoId, { caption: text ? `📢 ${text}` : "", parse_mode: "Markdown" });
        success++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 100));
    }
    bot.sendMessage(msg.chat.id, `✅ Yuborildi: *${success}*\n❌ Yuborilmadi: *${failed}*`, { parse_mode: "Markdown" });
    return;
  }

  // Video yuborish
  if (msg.video && msg.caption && msg.caption.startsWith("/sendvideo")) {
    const text = msg.caption.replace("/sendvideo", "").trim();
    const videoId = msg.video.file_id;
    bot.sendMessage(msg.chat.id, `🎥 *${users.length}* ta foydalanuvchiga yuborilmoqda...`, { parse_mode: "Markdown" });
    let success = 0, failed = 0;
    for (const user of users) {
      try {
        await bot.sendVideo(user.id, videoId, { caption: text ? `📢 ${text}` : "", parse_mode: "Markdown" });
        success++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 100));
    }
    bot.sendMessage(msg.chat.id, `✅ Yuborildi: *${success}*\n❌ Yuborilmadi: *${failed}*`, { parse_mode: "Markdown" });
    return;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── ADMIN PANEL ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

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
    `📌 Komandalar:\n/users /messages /broadcast`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/users/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users).slice(-20);
  if (!users.length) return bot.sendMessage(msg.chat.id, "Foydalanuvchilar yo'q.");

  let text = `👥 *Foydalanuvchilar (oxirgi 20):*\n\n`;
  users.forEach((u, i) => {
    const prem = isUserPremium(u.id) ? "💎" : "🆓";
    text += `${i + 1}. ${prem} *${u.name || "Noma'lum"}*\n   @${u.username || "yo'q"} | ID: \`${u.id}\` | 💬${u.messageCount || 0}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/messages/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const messages = (db.messages || []).slice(-15).reverse();
  if (!messages.length) return bot.sendMessage(msg.chat.id, "Xabarlar yo'q.");

  let text = `💬 *Oxirgi xabarlar:*\n\n`;
  messages.forEach((m, i) => {
    const time = new Date(m.time).toLocaleTimeString("uz-UZ");
    text += `${i + 1}. *${m.name}* (${time})\n   🤖 ${m.model} | "${m.text.substring(0, 60)}"\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/givepremium (.+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1]);
  if (isNaN(targetId)) return bot.sendMessage(msg.chat.id, "❌ Noto'g'ri ID!");
  const user = getUser(targetId);
  bot.sendMessage(msg.chat.id,
    `*${user.name || targetId}* ga Premium berishni tasdiqlaysizmi?\nID: \`${targetId}\``,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "✅ Premium ber", callback_data: `give_premium_${targetId}` }]] }
    }
  );
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const text = match[1];
  const db = loadDB();
  const users = Object.values(db.users);
  bot.sendMessage(msg.chat.id, `📢 *${users.length}* ta foydalanuvchiga yuborilmoqda...`, { parse_mode: "Markdown" });
  let success = 0, failed = 0;
  for (const user of users) {
    try {
      await bot.sendMessage(user.id, `📢 *Xabar:*\n\n${text}`, { parse_mode: "Markdown" });
      success++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 100));
  }
  bot.sendMessage(msg.chat.id, `✅ Yuborildi: *${success}*\n❌ Muvaffaqiyatsiz: *${failed}*`, { parse_mode: "Markdown" });
});

console.log("🤖 Telegram bot ishga tushdi...");
console.log(`👑 Admin ID: ${ADMIN_ID}`);
