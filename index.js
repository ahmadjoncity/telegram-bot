"use strict";

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const { CohereClient } = require("cohere-ai");
const fs = require("fs");
const path = require("path");

// ---------------- ENV & validatsiya ----------------
const BOT_TOKEN  = process.env.TELEGRAM_TOKEN;
const GROQ_KEY   = process.env.GROQ_API_KEY;
const COHERE_KEY = process.env.COHERE_API_KEY;
const ADMIN_ID   = parseInt(process.env.ADMIN_ID || "0", 10);
const CHANNEL    = (process.env.REQUIRED_CHANNEL || "@ustozaka_ai").trim();
const INSTA_URL  = process.env.INSTAGRAM_URL || "https://instagram.com/ustozainews";
const EXAM_URL   = process.env.EXAM_URL || "https://htmlpreview.github.io/?https://github.com/ahmadjoncity/alxorazmiytayyorlov/blob/main/index.html";
const FREE_DAYS  = parseInt(process.env.FREE_DAYS || "20", 10);
const PREMIUM_SOM = parseInt(process.env.PREMIUM_SOM || "15000", 10);
const STARS      = parseInt(process.env.PREMIUM_STARS || "50", 10);
const PAYME_ID   = process.env.PAYME_MERCHANT_ID || "";
const CLICK_ID   = process.env.CLICK_MERCHANT_ID || "";

if (!BOT_TOKEN) {
  console.error("XATO: TELEGRAM_TOKEN .env faylida ko'rsatilmagan!");
  process.exit(1);
}
if (!GROQ_KEY && !COHERE_KEY) {
  console.error("XATO: kamida bitta AI kalit kerak (GROQ_API_KEY yoki COHERE_API_KEY)!");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.warn("OGOHLANTIRISH: ADMIN_ID berilmagan — admin buyruqlari ishlamaydi.");
}
if (!CHANNEL.startsWith("@")) {
  console.warn("OGOHLANTIRISH: REQUIRED_CHANNEL '@' belgisi bilan boshlanishi kerak.");
}

// ---------------- DB ----------------
// DB fayl yo'li. Railway/Render kabi platformalarda fayl tizimi vaqtinchalik bo'lgani
// uchun Volume ulab, DB_FILE=/data/db.json qilib bering (aks holda har deployda o'chadi!).
const DB_PATH = process.env.DB_FILE || path.join(__dirname, "db.json");
let dbCache = null;

function loadDB() {
  if (dbCache) return dbCache;
  try {
    // DB papkasi mavjudligini ta'minlash (masalan Volume: /data)
    const dir = path.dirname(DB_PATH);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
      dbCache = { users: {}, msgs: [] };
      saveDB();
      return dbCache;
    }
    dbCache = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!dbCache.users) dbCache.users = {};
    if (!dbCache.msgs)  dbCache.msgs  = [];
    // Migratsiya: eski/buzuq yozuvlarda 'joined' yo'q bo'lsa to'ldiramiz.
    // Bu "NaN kun qoldi" xatosini ham tuzatadi.
    let migrated = false;
    for (const uid of Object.keys(dbCache.users)) {
      const u = dbCache.users[uid];
      if (!u || typeof u !== "object") continue;
      if (!u.joined || !Number.isFinite(new Date(u.joined).getTime())) {
        u.joined = new Date().toISOString();
        migrated = true;
      }
      if (u.id === undefined) u.id = isNaN(parseInt(uid, 10)) ? uid : parseInt(uid, 10);
    }
    if (migrated) flushDB();
  } catch (e) {
    console.error("DB o'qib bo'lmadi, yangidan yaratildi:", e.message);
    dbCache = { users: {}, msgs: [] };
  }
  return dbCache;
}

let saveTimer = null;
function saveDB() {
  // debounce: ko'p marta chaqirilsa ham 300ms da bir marta yoziladi
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(dbCache, null, 2));
      fs.renameSync(tmp, DB_PATH);
    } catch (e) {
      console.error("DB yozib bo'lmadi:", e.message);
    }
  }, 300);
}

function flushDB() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(dbCache, null, 2));
  } catch (e) {
    console.error("DB flush xato:", e.message);
  }
}

function getUser(id) {
  const db = loadDB();
  if (!db.users[id]) {
    db.users[id] = {
      id,
      name: "",
      username: "",
      count: 0,
      premium: false,
      premiumUntil: null,
      joined: new Date().toISOString(),
      firstUseAt: null,
    };
    saveDB();
  }
  return db.users[id];
}

function setUser(id, data) {
  // MUHIM: avval getUser chaqiramiz — bu default maydonlar (joined, firstUseAt, ...)
  // borligini kafolatlaydi. Aks holda yangi user faqat 'data' bilan yaratilib,
  // 'joined' yo'q bo'lib qoladi va daysLeft "NaN" qaytaradi.
  const base = getUser(id);
  const db = loadDB();
  db.users[id] = Object.assign({}, base, data);
  saveDB();
}

function addMsg(id, name, uname, text, model) {
  const db = loadDB();
  db.msgs.push({
    id, name, uname,
    text: String(text).slice(0, 150),
    model,
    t: new Date().toISOString(),
  });
  if (db.msgs.length > 1000) db.msgs = db.msgs.slice(-1000);
  saveDB();
}

function isPremium(id) {
  if (id === ADMIN_ID) return true;
  const u = getUser(id);
  return !!(u.premium && u.premiumUntil && new Date(u.premiumUntil) > new Date());
}

function daysLeft(id) {
  const u = getUser(id);
  const freeDays = Number.isFinite(FREE_DAYS) ? FREE_DAYS : 20;
  // Bepul muddat birinchi foydalanishdan boshlab, agar yo'q bo'lsa joined dan
  const startRaw = u.firstUseAt || u.joined;
  let startMs = new Date(startRaw).getTime();
  if (!Number.isFinite(startMs)) startMs = Date.now(); // sana buzuq/yo'q bo'lsa, bugundan
  const diff = (Date.now() - startMs) / 86400000;
  return Math.max(0, freeDays - Math.floor(diff));
}

function canUseAI(id) {
  if (id === ADMIN_ID) return true;
  if (isPremium(id)) return true;
  return daysLeft(id) > 0;
}

// ---------------- Bot ----------------
const bot   = new TelegramBot(BOT_TOKEN, { polling: true });
const groq  = GROQ_KEY   ? new Groq({ apiKey: GROQ_KEY }) : null;
const cohere = COHERE_KEY ? new CohereClient({ token: COHERE_KEY }) : null;

const histories = new Map();   // userId -> [{role, content}]
const models    = new Map();   // userId -> "groq"|"cohere"
const subCache  = new Map();   // userId -> { ok: boolean, t: timestamp }
const lastMsgAt = new Map();   // userId -> timestamp (rate-limit)
const HISTORY_MAX = 20;        // oxirgi 20 ta xabar (10 ta savol-javob)
const SUB_TTL_MS  = 60_000;    // 1 daqiqa
const RATE_MS     = 1500;      // 1.5 sek minimal interval

bot.on("polling_error", (e) => {
  console.error("Polling xato:", e.code || "", e.message || e);
});
bot.on("error", (e) => console.error("Bot xato:", e.message || e));

// Default model: GROQ bor bo'lsa groq, aks holda cohere
function defaultModel() {
  if (groq) return "groq";
  if (cohere) return "cohere";
  return null;
}

// ---------------- Yordamchi: xavfsiz so'rovlar ----------------
async function safe(fn, label = "") {
  try { return await fn(); }
  catch (e) { console.error("safe[" + label + "]:", e.message || e); return null; }
}

async function safeDeleteMessage(chatId, msgId) {
  try { await bot.deleteMessage(chatId, msgId); }
  catch (_) { /* xabar yo'q yoki ruxsat yo'q */ }
}

async function subOk(id) {
  const cached = subCache.get(id);
  if (cached && Date.now() - cached.t < SUB_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const m = await bot.getChatMember(CHANNEL, id);
    ok = ["member", "administrator", "creator"].includes(m.status);
  } catch (e) {
    console.error("subOk xato:", e.message);
    ok = false;
  }
  subCache.set(id, { ok, t: Date.now() });
  return ok;
}

// Markdown* belgilarini tozalash (parse_mode ishlatmasdan toza ko'rinish uchun)
function cleanMarkdown(s) {
  if (!s) return "";
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`{3}[\s\S]*?`{3}/g, m => m.replace(/`/g, ""))
    .replace(/`([^`]+)`/g, "$1");
}

// Uzun xabarni so'z chegarasidan bo'lib yuborish
function splitMessage(text, limit = 4000) {
  const out = [];
  let buf = "";
  for (const line of String(text).split("\n")) {
    if ((buf + "\n" + line).length > limit) {
      if (buf) out.push(buf);
      // Agar bitta qatorning o'zi limitdan katta bo'lsa, qattiq kesib yuboramiz
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          out.push(line.slice(i, i + limit));
        }
        buf = "";
      } else {
        buf = line;
      }
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function channelUrl() {
  return "https://t.me/" + CHANNEL.replace(/^@/, "");
}

// ---------------- Menyu ----------------
const MENU = {
  keyboard: [
    [{ text: "🎓 Imtihon test" }],
    [{ text: "🤖 Savol berish" }, { text: "⚙️ AI tanlash" }],
    [{ text: "📋 Vazifalar" }, { text: "📊 Hisobim" }],
    [{ text: "💎 Premium" }, { text: "ℹ️ Yordam" }],
  ],
  resize_keyboard: true,
};

// ---------------- Komandalar ----------------
bot.onText(/^\/start\b/, async (msg) => {
  const id = msg.from.id;
  const name = msg.from.first_name || "Do'stim";
  setUser(id, { name, username: msg.from.username || "" });

  if (id !== ADMIN_ID) {
    const ok = await subOk(id);
    if (!ok) {
      return bot.sendMessage(
        id,
        "Salom " + name + "!\n\nBotdan foydalanish uchun:\n\n1. Telegram kanalga obuna bo'ling\n2. Instagram da follow bosing\n\nKeyin Tekshirish tugmasini bosing!",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Telegram kanal", url: channelUrl() }],
              [{ text: "Instagram", url: INSTA_URL }],
              [{ text: "Obunani tekshirish ✅", callback_data: "checksub" }],
            ],
          },
        }
      );
    }
  }

  const d = daysLeft(id);
  const prem = isPremium(id);
  bot.sendMessage(
    id,
    "Salom " + name + "! Xush kelibsiz!\n\n" +
      (prem ? "💎 Premium faol" : "Bepul muddat: " + d + " kun qoldi") +
      "\n\nQuyidagi menyudan foydalaning:",
    { reply_markup: MENU }
  );
});

bot.onText(/^\/reset\b/, (msg) => {
  histories.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "Suhbat tozalandi!", { reply_markup: MENU });
});

bot.onText(/^\/(premium|prem)\b/, (msg) => showPremium(msg.chat.id, msg.from.id));

bot.onText(/^\/(help|yordam)\b/, (msg) => sendHelp(msg.chat.id));

bot.onText(/^\/paid\b/, (msg) => {
  const id = msg.from.id;
  bot.sendMessage(id, "To'lovingiz admin ko'rib chiqmoqda. Tez orada faollashtiriladi!");
  if (ADMIN_ID) {
    bot.sendMessage(
      ADMIN_ID,
      "Yangi to'lov!\nIsm: " + (msg.from.first_name || "-") +
        "\nUsername: @" + (msg.from.username || "yo'q") +
        "\nID: " + id,
      { reply_markup: { inline_keyboard: [[{ text: "Premium ber ✅", callback_data: "giveprem_" + id }]] } }
    );
  }
});

// ---------------- Admin ----------------
bot.onText(/^\/stats\b/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users);
  const prem = users.filter(u => isPremium(u.id)).length;
  const today = new Date().toDateString();
  const tm = db.msgs.filter(m => new Date(m.t).toDateString() === today).length;
  bot.sendMessage(
    msg.chat.id,
    "Statistika:\n\n" +
      "Jami foydalanuvchi: " + users.length + "\n" +
      "Premium: " + prem + "\n" +
      "Bepul: " + (users.length - prem) + "\n\n" +
      "Jami xabarlar: " + db.msgs.length + "\n" +
      "Bugungi xabarlar: " + tm
  );
});

bot.onText(/^\/users\b/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users).slice(-20);
  if (!users.length) return bot.sendMessage(msg.chat.id, "Yo'q.");
  let t = "Foydalanuvchilar (oxirgi 20):\n\n";
  users.forEach((u, i) => {
    t += (i + 1) + ". " + (isPremium(u.id) ? "💎" : "🆓") + " " +
      (u.name || "-") + " @" + (u.username || "yo'q") +
      " | " + u.id + " | " + (u.count || 0) + " xabar\n";
  });
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/^\/messages\b/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const msgs = db.msgs.slice(-15).reverse();
  if (!msgs.length) return bot.sendMessage(msg.chat.id, "Yo'q.");
  let t = "Oxirgi xabarlar:\n\n";
  msgs.forEach((m, i) => {
    t += (i + 1) + ". " + (m.name || "-") + " [" + m.model + "]\n" + m.text.slice(0, 60) + "\n\n";
  });
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/^\/givepremium\s+(.+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tid = parseInt(match[1], 10);
  if (!tid || isNaN(tid)) return bot.sendMessage(msg.chat.id, "Noto'g'ri ID!");
  bot.sendMessage(msg.chat.id, tid + " ga Premium berishni tasdiqlaysizmi?", {
    reply_markup: { inline_keyboard: [[{ text: "Ha, ber!", callback_data: "giveprem_" + tid }]] },
  });
});

bot.onText(/^\/broadcast\s+([\s\S]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const text = match[1];
  const db = loadDB();
  const users = Object.values(db.users);
  bot.sendMessage(msg.chat.id, users.length + " ga yuborilmoqda...");
  let s = 0, f = 0;
  for (const u of users) {
    try { await bot.sendMessage(u.id, "Xabar:\n\n" + text); s++; } catch { f++; }
    await new Promise(r => setTimeout(r, 50));
  }
  bot.sendMessage(msg.chat.id, "Yuborildi: " + s + "\nYuborilmadi: " + f);
});

// ---------------- Callback ----------------
bot.on("callback_query", async (q) => {
  const id = q.from.id;
  const data = q.data || "";

  try {
    if (data === "checksub") {
      subCache.delete(id);
      const ok = await subOk(id);
      if (ok) {
        await safe(() => bot.answerCallbackQuery(q.id, { text: "Tasdiqlandi!" }), "answerCB");
        await safeDeleteMessage(q.message.chat.id, q.message.message_id);
        const d = daysLeft(id);
        await bot.sendMessage(id, "Obuna tasdiqlandi!\n\nBepul muddat: " + d + " kun\n\nMenyudan foydalaning:", { reply_markup: MENU });
      } else {
        await safe(() => bot.answerCallbackQuery(q.id, { text: "Hali obuna bo'lmadingiz!", show_alert: true }), "answerCB");
      }
      return;
    }

    if (data === "groq") {
      if (!groq) {
        await safe(() => bot.answerCallbackQuery(q.id, { text: "Groq sozlanmagan!", show_alert: true }));
        return;
      }
      models.set(id, "groq"); histories.delete(id);
      await safe(() => bot.answerCallbackQuery(q.id, { text: "Groq tanlandi!" }));
      await bot.sendMessage(q.message.chat.id, "Groq (Llama 3.3) tanlandi!");
      return;
    }
    if (data === "cohere") {
      if (!cohere) {
        await safe(() => bot.answerCallbackQuery(q.id, { text: "Cohere sozlanmagan!", show_alert: true }));
        return;
      }
      models.set(id, "cohere"); histories.delete(id);
      await safe(() => bot.answerCallbackQuery(q.id, { text: "Cohere tanlandi!" }));
      await bot.sendMessage(q.message.chat.id, "Cohere tanlandi!");
      return;
    }

    if (data === "pay_payme") {
      await safe(() => bot.answerCallbackQuery(q.id));
      if (!PAYME_ID) {
        await bot.sendMessage(q.message.chat.id, "Payme hali sozlanmagan. Iltimos, /paid yoki Click yoki Telegram Stars usulidan foydalaning.");
      } else {
        await bot.sendMessage(q.message.chat.id, "Payme orqali to'lash:\nhttps://checkout.paycom.uz/" + PAYME_ID + "\n\nTo'lovdan keyin /paid yuboring!");
      }
      return;
    }
    if (data === "pay_click") {
      await safe(() => bot.answerCallbackQuery(q.id));
      if (!CLICK_ID) {
        await bot.sendMessage(q.message.chat.id, "Click hali sozlanmagan. Iltimos, /paid yoki Payme yoki Telegram Stars usulidan foydalaning.");
      } else {
        await bot.sendMessage(
          q.message.chat.id,
          "Click orqali to'lash:\nhttps://my.click.uz/services/pay?service_id=" + CLICK_ID +
            "&amount=" + PREMIUM_SOM + "&transaction_param=" + id +
            "\n\nTo'lovdan keyin /paid yuboring!"
        );
      }
      return;
    }
    if (data === "pay_stars") {
      await safe(() => bot.answerCallbackQuery(q.id));
      try {
        await bot.sendInvoice(
          q.message.chat.id,
          "Premium obuna",
          "1 oylik cheksiz foydalanish",
          "prem_" + id,
          "XTR",
          [{ label: "1 oy Premium", amount: STARS }]
        );
      } catch (e) {
        console.error("sendInvoice:", e.message);
        await bot.sendMessage(q.message.chat.id, "Stars to'lovini yaratib bo'lmadi. Boshqa usulni tanlang.");
      }
      return;
    }

    if (data.startsWith("giveprem_") && id === ADMIN_ID) {
      const tid = parseInt(data.replace("giveprem_", ""), 10);
      if (!tid) return safe(() => bot.answerCallbackQuery(q.id, { text: "Noto'g'ri ID" }));
      const until = new Date(); until.setMonth(until.getMonth() + 1);
      setUser(tid, { premium: true, premiumUntil: until.toISOString() });
      await safe(() => bot.answerCallbackQuery(q.id, { text: "Premium berildi!" }));
      await bot.sendMessage(q.message.chat.id, tid + " ga Premium berildi!");
      await safe(() => bot.sendMessage(tid, "Premium faollashtirildi! 1 oy cheksiz foydalaning!"), "notifyUser");
      return;
    }

    const tasks = {
      tw: "Qanday matn yozib berishimni xohlaysiz?\nMasalan: she'r yoz, xat yoz",
      tt: "Qaysi matnni qaysi tilga tarjima qilishimni?\nMasalan: Hello - uzbekchaga tarjima qil",
      tc: "Qanday kod yozib berishimni?\nMasalan: Python da kalkulyator yoz",
      ts: "Matningizni yuboring, xulosa chiqaraman!",
      tm2: "Masalangizni yozing!\nMasalan: 2x+5=15, x ni top",
      ti: "Qaysi mavzuda fikr kerak?\nMasalan: biznes g'oyalar ber",
      te: "Nimani tushuntirishimni?\nMasalan: sun'iy intellekt nima",
    };
    if (tasks[data]) {
      await safe(() => bot.answerCallbackQuery(q.id));
      await bot.sendMessage(q.message.chat.id, tasks[data]);
      return;
    }

    await safe(() => bot.answerCallbackQuery(q.id));
  } catch (e) {
    console.error("callback_query xato:", e.message);
    await safe(() => bot.answerCallbackQuery(q.id, { text: "Xatolik yuz berdi" }));
  }
});

// ---------------- Asosiy xabar handler ----------------
bot.on("message", async (msg) => {
  const id = msg.from.id;

  // Admin uchun rasm/video broadcast
  if ((msg.photo || msg.video) && id === ADMIN_ID) {
    const db = loadDB();
    const users = Object.values(db.users);
    if (msg.photo && msg.caption && msg.caption.startsWith("/sendphoto")) {
      const cap = msg.caption.replace("/sendphoto", "").trim();
      const pid = msg.photo[msg.photo.length - 1].file_id;
      bot.sendMessage(id, users.length + " ga rasm yuborilmoqda...");
      let s = 0, f = 0;
      for (const u of users) {
        try { await bot.sendPhoto(u.id, pid, { caption: cap }); s++; } catch { f++; }
        await new Promise(r => setTimeout(r, 50));
      }
      bot.sendMessage(id, "Yuborildi: " + s + "\nYuborilmadi: " + f);
      return;
    }
    if (msg.video && msg.caption && msg.caption.startsWith("/sendvideo")) {
      const cap = msg.caption.replace("/sendvideo", "").trim();
      const vid = msg.video.file_id;
      bot.sendMessage(id, users.length + " ga video yuborilmoqda...");
      let s = 0, f = 0;
      for (const u of users) {
        try { await bot.sendVideo(u.id, vid, { caption: cap }); s++; } catch { f++; }
        await new Promise(r => setTimeout(r, 50));
      }
      bot.sendMessage(id, "Yuborildi: " + s + "\nYuborilmadi: " + f);
      return;
    }
    return;
  }

  if (!msg.text) return;
  const text = msg.text;
  if (text.startsWith("/")) return; // komandalar yuqorida ushlanadi

  // Obuna tekshirish (admin uchun emas)
  if (id !== ADMIN_ID) {
    const ok = await subOk(id);
    if (!ok) {
      return bot.sendMessage(
        id,
        "Botdan foydalanish uchun kanalga obuna bo'ling:\n" + CHANNEL,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Kanalga kirish", url: channelUrl() }],
              [{ text: "Obunani tekshirish ✅", callback_data: "checksub" }],
            ],
          },
        }
      );
    }
  }

  // Imtihon test menyusi (har doim ochiq)
  if (text === "🎓 Imtihon test") {
    return bot.sendMessage(
      id,
      "🎓 Al-Xorazmiy maktabi — 9-sinf imtihon testi\n\n" +
        "📝 50 ta savol  •  ⏱ 2,5 soat  •  💯 100 ball\n" +
        "Fanlar: Matematika, Geometriya, Fizika, Ingliz tili\n\n" +
        "Imtihondan o'tish uchun kamida 60 ball to'plang!\n" +
        "Quyidagi tugma orqali testni boshlang:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Testni ochish", url: EXAM_URL }],
            [{ text: "📱 Telegram ichida ochish", web_app: { url: EXAM_URL } }],
          ],
        },
      }
    );
  }

  // Menyu tugmalari (limitsiz)
  if (text === "📊 Hisobim") {
    const u = getUser(id);
    const prem = isPremium(id);
    const d = daysLeft(id);
    const until = u.premiumUntil ? new Date(u.premiumUntil).toLocaleDateString() : "-";
    return bot.sendMessage(
      id,
      "Hisobingiz:\n\n" +
        "Ism: " + (u.name || "-") + "\n" +
        "ID: " + id + "\n" +
        "Status: " + (prem ? "Premium 💎" : "Bepul") + "\n" +
        (prem ? "Muddat: " + until : "Qoldi: " + d + " kun") + "\n" +
        "Xabarlar: " + (u.count || 0)
    );
  }

  if (text === "💎 Premium")  return showPremium(id, id);
  if (text === "ℹ️ Yordam")    return sendHelp(id);

  if (text === "🤖 Savol berish")
    return bot.sendMessage(id, "Savolingizni yozing!", { reply_markup: MENU });

  if (text === "⚙️ AI tanlash") {
    const cur = models.get(id) || defaultModel();
    const rows = [];
    if (groq)   rows.push([{ text: "Groq (Llama 3.3)" + (cur === "groq"   ? " ✅" : ""), callback_data: "groq" }]);
    if (cohere) rows.push([{ text: "Cohere"          + (cur === "cohere" ? " ✅" : ""), callback_data: "cohere" }]);
    if (!rows.length) return bot.sendMessage(id, "Hech qaysi AI sozlanmagan.");
    return bot.sendMessage(id, "Qaysi AI ni tanlaysiz?", { reply_markup: { inline_keyboard: rows } });
  }

  if (text === "📋 Vazifalar") {
    return bot.sendMessage(id, "Vazifani tanlang:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Matn yozish ✍️", callback_data: "tw" }],
          [{ text: "Tarjima 🌐", callback_data: "tt" }],
          [{ text: "Kod yozish 💻", callback_data: "tc" }],
          [{ text: "Xulosa 📝", callback_data: "ts" }],
          [{ text: "Matematika 🧮", callback_data: "tm2" }],
          [{ text: "G'oya 💡", callback_data: "ti" }],
          [{ text: "Tushuntirish 📖", callback_data: "te" }],
        ],
      },
    });
  }

  // ---- Bu yerdan AI savol-javob boshlanadi ----
  // Bepul muddatni birinchi savol/javobdan boshlash
  const u0 = getUser(id);
  if (!u0.firstUseAt) setUser(id, { firstUseAt: new Date().toISOString() });

  if (!canUseAI(id)) {
    return bot.sendMessage(
      id,
      "Bepul muddat tugadi!\n\nPremium oling — cheksiz foydalaning!\n/premium"
    );
  }

  // Rate-limit
  const now = Date.now();
  const last = lastMsgAt.get(id) || 0;
  if (now - last < RATE_MS) {
    return bot.sendMessage(id, "Juda tez yozayapsiz, biroz kuting...");
  }
  lastMsgAt.set(id, now);

  // Qaysi AI?
  let model = models.get(id) || defaultModel();
  if (!model) return bot.sendMessage(id, "Hech qaysi AI sozlanmagan. Admin bilan bog'laning.");
  if (model === "groq" && !groq)   model = "cohere";
  if (model === "cohere" && !cohere) model = "groq";
  models.set(id, model);

  // Foydalanuvchi ma'lumoti
  setUser(id, {
    name: msg.from.first_name || "",
    username: msg.from.username || "",
    lastMsg: new Date().toISOString(),
  });
  addMsg(id, msg.from.first_name || "", msg.from.username || "", text, model);
  setUser(id, { count: (getUser(id).count || 0) + 1 });

  await safe(() => bot.sendChatAction(id, "typing"), "typing");

  if (!histories.has(id)) histories.set(id, []);
  const hist = histories.get(id);

  try {
    let reply = "";

    if (model === "cohere") {
      const ch = hist.map(h => ({
        role: h.role === "user" ? "USER" : "CHATBOT",
        message: h.content,
      }));
      const res = await cohere.chat({
        model: "command-a-03-2025",
        message: text,
        chatHistory: ch,
      });
      reply = res.text || "";
      hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: reply });
    } else {
      hist.push({ role: "user", content: text });
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: hist,
        max_tokens: 1024,
      });
      reply = (res.choices && res.choices[0] && res.choices[0].message.content) || "";
      hist.push({ role: "assistant", content: reply });
    }

    // Tarixni qisqartirish
    while (hist.length > HISTORY_MAX) hist.shift();

    if (!reply.trim()) reply = "Kechirasiz, javob bo'sh keldi. /reset yozib qaytadan urinib ko'ring.";

    const d = daysLeft(id);
    if (!isPremium(id) && d <= 3 && d > 0) {
      reply += "\n\nEslatma: " + d + " kun bepul qoldi! /premium";
    }

    const chunks = splitMessage(cleanMarkdown(reply), 4000);
    for (const chunk of chunks) {
      await bot.sendMessage(id, chunk, { disable_web_page_preview: true });
    }
  } catch (err) {
    console.error("AI xato (" + model + "):", err.message);
    // Tarixni teskari qaytaramiz, oxirgi savolni o'chirib
    if (hist.length && hist[hist.length - 1].role === "user") hist.pop();
    await bot.sendMessage(id, "Xatolik yuz berdi. /reset yozing yoki keyinroq qayta urinib ko'ring.");
  }
});

// ---------------- Premium ----------------
function showPremium(chatId, userId) {
  if (isPremium(userId)) {
    const u = getUser(userId);
    const until = u.premiumUntil ? new Date(u.premiumUntil).toLocaleDateString() : "Cheksiz";
    return bot.sendMessage(chatId, "Siz Premium foydalanuvchisiz!\nMuddat: " + until);
  }
  const rows = [];
  if (PAYME_ID) rows.push([{ text: "Payme",  callback_data: "pay_payme"  }]);
  if (CLICK_ID) rows.push([{ text: "Click",  callback_data: "pay_click"  }]);
  rows.push([{ text: "Telegram Stars (" + STARS + " ⭐)", callback_data: "pay_stars" }]);

  const note = (!PAYME_ID && !CLICK_ID)
    ? "\n\nPayme/Click hozircha sozlanmagan. Telegram Stars yoki admin orqali to'lovni tanlang."
    : "";

  bot.sendMessage(
    chatId,
    "Premium obuna - 1 oy\n\nCheksiz savollar\nGroq + Cohere AI\n\nNarx: " +
      PREMIUM_SOM.toLocaleString() + " so'm\n\nTo'lov usulini tanlang:" + note,
    { reply_markup: { inline_keyboard: rows } }
  );
}

function sendHelp(chatId) {
  bot.sendMessage(
    chatId,
    "Yordam:\n\n" +
      "🎓 Imtihon test - 9-sinf imtihoniga tayyorgarlik (50 ta savol)\n" +
      "🤖 Savol berish - AI ga savol yuboring\n" +
      "⚙️ AI tanlash - Groq yoki Cohere\n" +
      "📋 Vazifalar - tayyor vazifalar\n" +
      "📊 Hisobim - profil\n" +
      "💎 Premium - cheksiz foydalanish\n\n" +
      "Komandalar:\n" +
      "/start, /reset, /premium, /paid, /help\n\n" +
      "Kanal: " + CHANNEL
  );
}

// ---------------- To'lovlar ----------------
bot.on("pre_checkout_query", q => {
  safe(() => bot.answerPreCheckoutQuery(q.id, true), "preCheckout");
});

bot.on("successful_payment", (msg) => {
  const id = msg.from.id;
  const until = new Date(); until.setMonth(until.getMonth() + 1);
  setUser(id, { premium: true, premiumUntil: until.toISOString() });
  bot.sendMessage(id, "Premium faollashtirildi! 1 oy cheksiz foydalaning!");
  if (ADMIN_ID) {
    const name = msg.from.first_name || "-";
    const uname = msg.from.username ? "@" + msg.from.username : "yo'q";
    bot.sendMessage(ADMIN_ID, "Stars to'lov!\nIsm: " + name + "\nUsername: " + uname + "\nID: " + id);
  }
});

// ---------------- Graceful shutdown ----------------
function shutdown(signal) {
  console.log("Bot to'xtatilmoqda (" + signal + ")...");
  flushDB();
  bot.stopPolling().finally(() => process.exit(0));
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException",  (e) => console.error("uncaughtException:",  e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

console.log("Bot ishga tushdi! Admin ID: " + ADMIN_ID + ", Kanal: " + CHANNEL);
console.log("DB fayl: " + DB_PATH + " | Bepul kun: " + FREE_DAYS);
