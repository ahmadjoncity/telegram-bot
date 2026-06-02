require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const { CohereClient } = require("cohere-ai");
let Anthropic = null;
try {
  Anthropic = require("@anthropic-ai/sdk");
} catch (e) {
  console.warn("[OGOHLANTIRISH] @anthropic-ai/sdk topilmadi - Claude o'chirilgan. 'npm install' ni ishga tushiring.");
}
const fs = require("fs");
 
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const COHERE_KEY = process.env.COHERE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const CHANNEL = process.env.REQUIRED_CHANNEL || "@ustozaka_ai";
const FREE_DAYS = 20;
const STARS = 50;
const DB = "db.json";

// Rasm / video yaratish servislari
const IMAGE_API = process.env.IMAGE_API || "https://image.pollinations.ai/prompt/";
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "minimax/video-01";

// Premium to'lov kartasi
const CARD_NUMBER = process.env.CARD_NUMBER || "4023 0605 1167 3823";
const CARD_OWNER = process.env.CARD_OWNER || "Nodiraxon Dadaboyeva";

// Premium tariflar (2026 yil holatiga)
const PLANS = {
  "1":  { months: 1,  som: 14999,  label: "1 oy" },
  "3":  { months: 3,  som: 39999,  label: "3 oy" },
  "4":  { months: 4,  som: 49999,  label: "4 oy" },
  "5":  { months: 5,  som: 59999,  label: "5 oy" },
  "6":  { months: 6,  som: 69999,  label: "6 oy" },
  "12": { months: 12, som: 119999, label: "12 oy" },
};

// "Ustoz AI" persona
const SYSTEM_PROMPT = `Sen "Ustoz AI" — O'zbek tilidagi aqlli, kuchli va foydali ta'lim yordamchisisan.
- Har doim o'zbek tilida javob ber (boshqa til so'ralmasa).
- Javoblaring aniq, tushunarli, bosqichma-bosqich va rag'batlantiruvchi bo'lsin.
- Robototexnika, dasturlash, matematika, fizika, ingliz tili, imtihonlarga tayyorgarlik va boshqa mavzularda yuqori sifatli yordam ber.
- Kerak bo'lganda amaliy misollar va qadamlar keltir.`;
 
function loadDB() {
  if (!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify({users:{},msgs:[]}));
  try { return JSON.parse(fs.readFileSync(DB)); } catch { return {users:{},msgs:[]}; }
}
function saveDB(db) { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); }
 
function getUser(id) {
  const db = loadDB();
  if (!db.users[id]) {
    db.users[id] = { id, name:"", username:"", count:0, premium:false, premiumUntil:null, joined: new Date().toISOString() };
    saveDB(db);
  }
  return db.users[id];
}
function setUser(id, data) {
  const db = loadDB();
  db.users[id] = Object.assign({}, db.users[id], data);
  saveDB(db);
}
function addMsg(id, name, uname, text, model) {
  const db = loadDB();
  if (!db.msgs) db.msgs = [];
  db.msgs.push({ id, name, uname, text: text.slice(0,150), model, t: new Date().toISOString() });
  if (db.msgs.length > 1000) db.msgs = db.msgs.slice(-1000);
  saveDB(db);
}
function isPremium(id) {
  if (id === ADMIN_ID) return true;
  const u = getUser(id);
  return u.premium && u.premiumUntil && new Date(u.premiumUntil) > new Date();
}
function daysLeft(id) {
  const u = getUser(id);
  const diff = (Date.now() - new Date(u.joined)) / 86400000;
  return Math.max(0, FREE_DAYS - Math.floor(diff));
}
function canUse(id) {
  if (id === ADMIN_ID) return true;
  if (isPremium(id)) return true;
  return daysLeft(id) > 0;
}
 
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_KEY });
const cohere = new CohereClient({ token: COHERE_KEY });
const anthropic = (ANTHROPIC_KEY && Anthropic) ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const histories = new Map();
const models = new Map();
const pendingAction = new Map(); // id -> "image" | "video"
 
async function subOk(id) {
  try {
    const m = await bot.getChatMember(CHANNEL, id);
    return ["member","administrator","creator"].includes(m.status);
  } catch { return false; }
}

// Premium foydalanuvchi uchun AI'ga qo'shimcha ko'rsatma
function premiumNote(id) {
  return isPremium(id)
    ? "\nBu foydalanuvchi 🌟 Premium obunachi — unga ustuvor, chuqurroq va batafsil yordam ber, \"Premium\" deb murojaat qil."
    : "";
}

// Telegram faylini base64 ga aylantirish (vision uchun)
async function tgFileBase64(fileId) {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

// Claude (matn yoki rasm bilan savol)
async function askClaude(text, hist, sysPrompt, imageB64) {
  const messages = (hist || []).map(h => ({
    role: h.role === "assistant" ? "assistant" : "user",
    content: h.content,
  }));
  const content = [];
  if (imageB64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } });
  }
  content.push({ type: "text", text: text });
  messages.push({ role: "user", content });
  const res = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: sysPrompt,
    messages,
  });
  return res.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

// Rasm yaratish (Pollinations - bepul, kalit kerak emas)
async function genImage(prompt) {
  const url = IMAGE_API + encodeURIComponent(prompt) +
    "?width=1024&height=1024&nologo=true&seed=" + Math.floor(Math.random() * 1e6);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Rasm API xatosi: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Video yaratish (Replicate - ixtiyoriy, token kerak)
async function genVideo(prompt) {
  if (!REPLICATE_TOKEN) return null;
  const headers = { Authorization: "Bearer " + REPLICATE_TOKEN, "Content-Type": "application/json" };
  const start = await fetch("https://api.replicate.com/v1/models/" + REPLICATE_VIDEO_MODEL + "/predictions", {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { prompt } }),
  });
  let pred = await start.json();
  if (pred.error) throw new Error(pred.error.detail || pred.error);
  let tries = 0;
  while (pred.status && !["succeeded", "failed", "canceled"].includes(pred.status) && tries < 80) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await fetch(pred.urls.get, { headers });
    pred = await p.json();
    tries++;
  }
  if (pred.status !== "succeeded") throw new Error("status: " + pred.status);
  const out = pred.output;
  return Array.isArray(out) ? out[out.length - 1] : out;
}

// Rasm yaratish oqimi (umumiy)
async function handleImageGen(id, prompt, fromName, fromUser) {
  if (id !== ADMIN_ID && !(await subOk(id))) return bot.sendMessage(id, "Avval kanalga obuna bo'ling: " + CHANNEL);
  if (!canUse(id)) return bot.sendMessage(id, "Bepul muddat tugadi!\nPremium oling: /premium");
  bot.sendMessage(id, "🎨 Rasm yaratilmoqda, biroz kuting...");
  bot.sendChatAction(id, "upload_photo");
  try {
    const buf = await genImage(prompt);
    await bot.sendPhoto(id, buf, { caption: "🎨 " + prompt.slice(0, 900) });
    addMsg(id, fromName || "", fromUser || "", "[RASM] " + prompt, "image");
    const u = getUser(id); setUser(id, { count: (u.count || 0) + 1 });
  } catch (e) {
    console.error("Rasm xato:", e.message);
    bot.sendMessage(id, "Rasm yaratishda xatolik yuz berdi. Keyinroq urinib ko'ring.");
  }
}

// Video yaratish oqimi (umumiy)
async function handleVideoGen(id, prompt, fromName, fromUser) {
  if (id !== ADMIN_ID && !(await subOk(id))) return bot.sendMessage(id, "Avval kanalga obuna bo'ling: " + CHANNEL);
  if (!canUse(id)) return bot.sendMessage(id, "Bepul muddat tugadi!\nPremium oling: /premium");
  if (!REPLICATE_TOKEN) return bot.sendMessage(id, "🎬 Video yaratish hozircha sozlanmagan.\nAdmin REPLICATE_API_TOKEN qo'shishi kerak.");
  bot.sendMessage(id, "🎬 Video yaratilmoqda. Bu 1-2 daqiqa olishi mumkin...");
  bot.sendChatAction(id, "upload_video");
  try {
    const url = await genVideo(prompt);
    if (!url) return bot.sendMessage(id, "Video yaratilmadi. Keyinroq urinib ko'ring.");
    await bot.sendVideo(id, url, { caption: "🎬 " + prompt.slice(0, 900) });
    addMsg(id, fromName || "", fromUser || "", "[VIDEO] " + prompt, "video");
    const u = getUser(id); setUser(id, { count: (u.count || 0) + 1 });
  } catch (e) {
    console.error("Video xato:", e.message);
    bot.sendMessage(id, "Video yaratishda xatolik: " + e.message);
  }
}
 
const MENU = {
  keyboard: [
    [{ text: "🤖 Savol berish" }, { text: "⚙️ AI tanlash" }],
    [{ text: "🎨 Rasm yaratish" }, { text: "🎬 Video yaratish" }],
    [{ text: "📋 Vazifalar" }, { text: "📊 Hisobim" }],
    [{ text: "💎 Premium" }, { text: "ℹ️ Yordam" }]
  ],
  resize_keyboard: true
};
 
bot.onText(/\/start/, async (msg) => {
  const id = msg.from.id;
  const name = msg.from.first_name || "Do'stim";
  setUser(id, { name, username: msg.from.username || "" });
 if (id !== ADMIN_ID) {
    const ok = await subOk(id);
    if (!ok) {
      return bot.sendMessage(id,
        "Salom " + name + "!\n\nBotdan foydalanish uchun:\n\n1. Telegram kanalga obuna buling\n2. Instagram da follow bosing\n\nKeyin Tekshirish tugmasini bosing!",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Telegram kanal", url: "https://t.me/ustozaka_ai" }],
              [{ text: "Instagram", url: "https://instagram.com/ustozainews" }],
              [{ text: "Obunani tekshirish ✅", callback_data: "checksub" }]
            ]
          }
        }
      );
    }
  }
  
 
  const d = daysLeft(id);
  const prem = isPremium(id);
  bot.sendMessage(id,
    "Salom " + name + "! Xush kelibsiz!\n\n" +
    (prem ? "💎 Premium faol" : "Bepul muddat: " + d + " kun qoldi") +
    "\n\nQuyidagi menyudan foydalaning:",
    { reply_markup: MENU }
  );
});
 
bot.onText(/\/reset/, (msg) => {
  histories.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "Suhbat tozalandi!", { reply_markup: MENU });
});
 
bot.onText(/\/premium/, (msg) => showPremium(msg.chat.id, msg.from.id));

bot.onText(/^\/rasm(?:@\w+)?\s+([\s\S]+)/, (msg, m) =>
  handleImageGen(msg.from.id, m[1].trim(), msg.from.first_name, msg.from.username));

bot.onText(/^\/video(?:@\w+)?\s+([\s\S]+)/, (msg, m) =>
  handleVideoGen(msg.from.id, m[1].trim(), msg.from.first_name, msg.from.username));
 
bot.onText(/\/paid/, (msg) => {
  const id = msg.from.id;
  bot.sendMessage(id, "To'lovingiz admin ko'rib chiqmoqda. Tez orada faollashtiriladi!");
  if (ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      "Yangi to'lov!\nIsm: " + (msg.from.first_name||"-") + "\nID: " + id,
      { reply_markup: { inline_keyboard: [[{ text: "Premium ber ✅", callback_data: "giveprem_"+id }]] }}
    );
  }
});
 
// Admin
bot.onText(/\/stats/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users);
  const prem = users.filter(u => isPremium(u.id)).length;
  const today = new Date().toDateString();
  const tm = (db.msgs||[]).filter(m => new Date(m.t).toDateString()===today).length;
  bot.sendMessage(msg.chat.id,
    "Statistika:\n\n" +
    "Jami foydalanuvchi: " + users.length + "\n" +
    "Premium: " + prem + "\n" +
    "Bepul: " + (users.length-prem) + "\n\n" +
    "Jami xabarlar: " + (db.msgs||[]).length + "\n" +
    "Bugungi xabarlar: " + tm
  );
});
 
bot.onText(/\/users/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const users = Object.values(db.users).slice(-20);
  if (!users.length) return bot.sendMessage(msg.chat.id, "Yo'q.");
  let t = "Foydalanuvchilar:\n\n";
  users.forEach((u,i) => {
    t += (i+1)+". "+(isPremium(u.id)?"💎":"🆓")+" "+(u.name||"-")+" @"+(u.username||"yo'q")+" | "+u.id+" | "+u.count+" xabar\n";
  });
  bot.sendMessage(msg.chat.id, t);
});
 
bot.onText(/\/messages/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = loadDB();
  const msgs = (db.msgs||[]).slice(-15).reverse();
  if (!msgs.length) return bot.sendMessage(msg.chat.id, "Yo'q.");
  let t = "Oxirgi xabarlar:\n\n";
  msgs.forEach((m,i) => {
    t += (i+1)+". "+(m.name||"-")+" ["+m.model+"]\n"+m.text.slice(0,60)+"\n\n";
  });
  bot.sendMessage(msg.chat.id, t);
});
 
bot.onText(/\/givepremium (.+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tid = parseInt(match[1]);
  if (isNaN(tid)) return bot.sendMessage(msg.chat.id, "Noto'g'ri ID!");
  bot.sendMessage(msg.chat.id, tid+" ga Premium berishni tasdiqlaysizmi?", {
    reply_markup: { inline_keyboard: [[{ text: "Ha, ber!", callback_data: "giveprem_"+tid }]] }
  });
});
 
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const text = match[1];
  const db = loadDB();
  const users = Object.values(db.users);
  bot.sendMessage(msg.chat.id, users.length+" ga yuborilmoqda...");
  let s=0, f=0;
  for (const u of users) {
    try { await bot.sendMessage(u.id, "Xabar:\n\n"+text); s++; } catch { f++; }
    await new Promise(r=>setTimeout(r,100));
  }
  bot.sendMessage(msg.chat.id, "Yuborildi: "+s+"\nYuborilmadi: "+f);
});
 
// Callback
bot.on("callback_query", async (q) => {
  const id = q.from.id;
  const data = q.data;
 
  if (data === "checksub") {
    const ok = await subOk(id);
    if (ok) {
      bot.answerCallbackQuery(q.id, { text: "Tasdiqlandi!" });
      bot.deleteMessage(q.message.chat.id, q.message.message_id);
      const d = daysLeft(id);
      bot.sendMessage(id, "Obuna tasdiqlandi!\n\nBepul muddat: "+d+" kun\n\nMenyudan foydalaning:", { reply_markup: MENU });
    } else {
      bot.answerCallbackQuery(q.id, { text: "Hali obuna bo'lmadingiz!", show_alert: true });
    }
    return;
  }
 
  if (data === "groq") {
    models.set(id, "groq"); histories.delete(id);
    bot.answerCallbackQuery(q.id, { text: "Groq tanlandi!" });
    bot.sendMessage(q.message.chat.id, "Groq (Llama 3.3) tanlandi!");
    return;
  }
  if (data === "cohere") {
    models.set(id, "cohere"); histories.delete(id);
    bot.answerCallbackQuery(q.id, { text: "Cohere tanlandi!" });
    bot.sendMessage(q.message.chat.id, "Cohere tanlandi!");
    return;
  }
  if (data === "claude") {
    if (!anthropic) { bot.answerCallbackQuery(q.id, { text: "Claude sozlanmagan!" }); return; }
    models.set(id, "claude"); histories.delete(id);
    bot.answerCallbackQuery(q.id, { text: "Claude tanlandi!" });
    bot.sendMessage(q.message.chat.id, "Claude (Anthropic) tanlandi! Endi matn va rasm bilan ishlay olasiz.");
    return;
  }
 
  if (data === "pay_payme") {
    bot.answerCallbackQuery(q.id);
    bot.sendMessage(q.message.chat.id, "Payme orqali to'lash:\nhttps://checkout.paycom.uz/"+process.env.PAYME_MERCHANT_ID+"\n\nTo'lovdan keyin /paid yuboring!");
    return;
  }
  if (data === "pay_click") {
    bot.answerCallbackQuery(q.id);
    bot.sendMessage(q.message.chat.id, "Click orqali to'lash:\nhttps://my.click.uz/services/pay?service_id="+process.env.CLICK_MERCHANT_ID+"&amount="+PLANS["1"].som+"&transaction_param="+id+"\n\nTo'lovdan keyin /paid yuboring!");
    return;
  }
  if (data === "pay_stars") {
    bot.answerCallbackQuery(q.id);
    await bot.sendInvoice(q.message.chat.id, "Premium obuna", "1 oylik cheksiz foydalanish", "prem_"+id, "XTR", [{ label: "1 oy Premium", amount: STARS }]);
    return;
  }

  if (data.startsWith("plan_")) {
    const key = data.replace("plan_", "");
    const plan = PLANS[key];
    if (!plan) return bot.answerCallbackQuery(q.id, { text: "Tarif topilmadi!" });
    setUser(id, { pendingPlan: key });
    bot.answerCallbackQuery(q.id, { text: plan.label + " tanlandi" });
    return bot.sendMessage(q.message.chat.id,
      "💳 To'lov ma'lumotlari\n\n" +
      "Tarif: " + plan.label + "\n" +
      "Summa: " + plan.som.toLocaleString() + " so'm\n\n" +
      "Karta raqami:\n`" + CARD_NUMBER + "`\n" +
      "Egasi: " + CARD_OWNER + "\n\n" +
      "To'lovni amalga oshirgach, chek (kvitansiya) rasmini shu yerga yuboring. " +
      "Admin tekshiradi va Premium obunangizni faollashtiradi.",
      { parse_mode: "Markdown" }
    );
  }
 
  if (data.startsWith("giveprem_") && id === ADMIN_ID) {
    const parts = data.replace("giveprem_", "").split("_");
    const tid = parseInt(parts[0]);
    const planKey = parts[1] || "1";
    const plan = PLANS[planKey] || PLANS["1"];
    if (isNaN(tid)) return bot.answerCallbackQuery(q.id, { text: "Noto'g'ri ID!" });
    // Premium hali tugamagan bo'lsa, uning ustiga qo'shamiz
    const cur = getUser(tid);
    const base = (cur.premium && cur.premiumUntil && new Date(cur.premiumUntil) > new Date())
      ? new Date(cur.premiumUntil) : new Date();
    base.setMonth(base.getMonth() + plan.months);
    setUser(tid, { premium: true, premiumUntil: base.toISOString(), pendingPlan: null });
    bot.answerCallbackQuery(q.id, { text: "Premium berildi!" });
    bot.sendMessage(q.message.chat.id, tid + " ga " + plan.label + " Premium berildi! (" + base.toLocaleDateString() + " gacha)");
    bot.sendMessage(tid, "🌟 Premium obunangiz faollashtirildi!\nTarif: " + plan.label + "\nMuddat: " + base.toLocaleDateString() + " gacha.\n\nEndi cheksiz foydalaning!");
    return;
  }

  if (data.startsWith("rejectpay_") && id === ADMIN_ID) {
    const tid = parseInt(data.replace("rejectpay_", ""));
    if (!isNaN(tid)) setUser(tid, { pendingPlan: null });
    bot.answerCallbackQuery(q.id, { text: "Rad etildi" });
    bot.sendMessage(q.message.chat.id, tid + " ning to'lovi rad etildi.");
    if (!isNaN(tid)) bot.sendMessage(tid, "❌ To'lovingiz tasdiqlanmadi. Chek noto'g'ri yoki to'liq emas bo'lishi mumkin. Iltimos, /premium orqali qayta urinib ko'ring.");
    return;
  }
 
  const tasks = {
    tw: "Qanday matn yozib berishimni xohlaysiz?\nMasalan: she'r yoz, xat yoz",
    tt: "Qaysi matni qaysi tilga tarjima qilishimni?\nMasalan: Hello - uzbekchaga tarjima qil",
    tc: "Qanday kod yozib berishimni?\nMasalan: Python da kalkulyator yoz",
    ts: "Matningizni yuboring, xulosa chiqaraman!",
    tm2: "Masalangizni yozing!\nMasalan: 2x+5=15, x ni top",
    ti: "Qaysi mavzuda fikr kerak?\nMasalan: biznes g'oyalar ber",
    te: "Nimani tushuntirishimni?\nMasalan: sun'iy intellekt nima",
  };
  if (tasks[data]) {
    bot.answerCallbackQuery(q.id);
    bot.sendMessage(q.message.chat.id, tasks[data]);
  }
});
 
// Xabarlar
bot.on("message", async (msg) => {
  const id = msg.from.id;
 
  // Rasm/video (admin)
  if ((msg.photo || msg.video) && id === ADMIN_ID) {
    const db = loadDB();
    const users = Object.values(db.users);
    if (msg.photo && msg.caption && msg.caption.startsWith("/sendphoto")) {
      const cap = msg.caption.replace("/sendphoto","").trim();
      const pid = msg.photo[msg.photo.length-1].file_id;
      bot.sendMessage(id, users.length+" ga rasm yuborilmoqda...");
      let s=0,f=0;
      for (const u of users) {
        try { await bot.sendPhoto(u.id, pid, { caption: cap }); s++; } catch { f++; }
        await new Promise(r=>setTimeout(r,100));
      }
      bot.sendMessage(id, "Yuborildi: "+s+"\nYuborilmadi: "+f);
      return;
    }
    if (msg.video && msg.caption && msg.caption.startsWith("/sendvideo")) {
      const cap = msg.caption.replace("/sendvideo","").trim();
      const vid = msg.video.file_id;
      bot.sendMessage(id, users.length+" ga video yuborilmoqda...");
      let s=0,f=0;
      for (const u of users) {
        try { await bot.sendVideo(u.id, vid, { caption: cap }); s++; } catch { f++; }
        await new Promise(r=>setTimeout(r,100));
      }
      bot.sendMessage(id, "Yuborildi: "+s+"\nYuborilmadi: "+f);
      return;
    }
    return;
  }
 
  // Rasm - oddiy foydalanuvchidan: to'lov cheki yoki rasmdan savol (vision)
  if (msg.photo && id !== ADMIN_ID) {
    const ok = await subOk(id);
    if (!ok) {
      return bot.sendMessage(id, "Avval kanalga obuna bo'ling: " + CHANNEL);
    }
    const u = getUser(id);
    const photoId = msg.photo[msg.photo.length - 1].file_id;

    // 1) Foydalanuvchi tarif tanlagan bo'lsa -> bu to'lov cheki
    if (u.pendingPlan) {
      const planKey = u.pendingPlan;
      const plan = PLANS[planKey] || null;
      bot.sendMessage(id, "✅ Chekingiz qabul qilindi!\n\nAdmin uni tekshiradi va Premium obunangizni faollashtiradi. Iltimos, biroz kuting.");
      if (ADMIN_ID) {
        const caption = "🧾 Yangi to'lov cheki\n\n" +
          "Ism: " + (msg.from.first_name || "-") + "\n" +
          "Username: @" + (msg.from.username || "yo'q") + "\n" +
          "ID: " + id + "\n" +
          "Tanlangan tarif: " + (plan ? plan.label + " (" + plan.som.toLocaleString() + " so'm)" : "belgilanmagan");
        let buttons;
        if (plan) {
          buttons = [
            [{ text: "✅ " + plan.label + " tasdiqlash", callback_data: "giveprem_" + id + "_" + planKey }],
            [{ text: "❌ Rad etish", callback_data: "rejectpay_" + id }],
          ];
        } else {
          buttons = Object.keys(PLANS).map(k => [{ text: "✅ " + PLANS[k].label, callback_data: "giveprem_" + id + "_" + k }]);
          buttons.push([{ text: "❌ Rad etish", callback_data: "rejectpay_" + id }]);
        }
        try {
          await bot.sendPhoto(ADMIN_ID, photoId, { caption, reply_markup: { inline_keyboard: buttons } });
        } catch (e) {
          bot.sendMessage(ADMIN_ID, caption);
        }
      }
      return;
    }

    // 2) Aks holda -> rasm haqida savol (Claude vision)
    if (!canUse(id)) {
      return bot.sendMessage(id, "Bepul muddat tugadi!\nPremium oling: /premium");
    }
    if (!anthropic) {
      return bot.sendMessage(id, "Rasm tahlili uchun Claude sozlanmagan.\nAdmin ANTHROPIC_API_KEY qo'shishi kerak.\n\n(Agar to'lov cheki yubormoqchi bo'lsangiz, avval /premium dan tarif tanlang.)");
    }
    bot.sendChatAction(id, "typing");
    try {
      const b64 = await tgFileBase64(photoId);
      const question = (msg.caption && msg.caption.trim())
        ? msg.caption.trim()
        : "Bu rasmda nima tasvirlangan? Batafsil tushuntir va kerak bo'lsa savolga javob ber.";
      const answer = await askClaude(question, [], SYSTEM_PROMPT + premiumNote(id), b64);
      addMsg(id, msg.from.first_name || "", msg.from.username || "", "[RASM SAVOL] " + question, "claude-vision");
      const uu = getUser(id); setUser(id, { count: (uu.count || 0) + 1 });
      const chunks = answer.match(/[\s\S]{1,4000}/g) || ["Javob topilmadi."];
      for (const c of chunks) await bot.sendMessage(id, c);
    } catch (e) {
      console.error("Vision xato:", e.message);
      bot.sendMessage(id, "Rasmni tahlil qilishda xatolik yuz berdi. Qayta urinib ko'ring.");
    }
    return;
  }

  if (!msg.text) return;
  const text = msg.text;
  if (text.startsWith("/")) return;
 
  // Obuna tekshirish
  if (id !== ADMIN_ID) {
    const ok = await subOk(id);
    if (!ok) {
      return bot.sendMessage(id, "Botdan foydalanish uchun kanalga obuna bo'ling:\n"+CHANNEL, {
        reply_markup: { inline_keyboard: [
          [{ text: "Kanalga kirish", url: "https://t.me/"+CHANNEL.replace("@","") }],
          [{ text: "Obunani tekshirish ✅", callback_data: "checksub" }]
        ]}
      });
    }
  }
 
  // Limit
  if (!canUse(id)) {
    return bot.sendMessage(id, "Bepul muddat tugadi!\n\nPremium oling - cheksiz foydalaning!\n/premium");
  }
 
  // Menyu tugmalari
  const MENU_LABELS = ["🤖 Savol berish","⚙️ AI tanlash","🎨 Rasm yaratish","🎬 Video yaratish","📋 Vazifalar","📊 Hisobim","💎 Premium","ℹ️ Yordam"];
  // Boshqa menyu tugmasi bosilsa, kutilayotgan rasm/video amalini bekor qilamiz
  if (MENU_LABELS.includes(text) && text !== "🎨 Rasm yaratish" && text !== "🎬 Video yaratish") pendingAction.delete(id);

  if (text === "🤖 Savol berish") return bot.sendMessage(id, "Savolingizni yozing!", { reply_markup: MENU });

  if (text === "🎨 Rasm yaratish") {
    pendingAction.set(id, "image");
    return bot.sendMessage(id, "🎨 Qanday rasm yaratay? Tasvirlab yozing.\nMasalan: tog' cho'qqisida quyosh chiqishi, realistik\n\nYoki: /rasm <tavsif>", { reply_markup: MENU });
  }
  if (text === "🎬 Video yaratish") {
    pendingAction.set(id, "video");
    return bot.sendMessage(id, "🎬 Qanday video yaratay? Tasvirlab yozing.\nMasalan: dengiz qirg'og'ida quyosh botishi\n\nYoki: /video <tavsif>", { reply_markup: MENU });
  }
 
  if (text === "⚙️ AI tanlash") {
    const cur = models.get(id) || "groq";
    return bot.sendMessage(id, "Qaysi AI ni tanlaysiz?", {
      reply_markup: { inline_keyboard: [
        [{ text: "Groq (Llama 3.3)"+(cur==="groq"?" ✅":""), callback_data: "groq" }],
        [{ text: "Cohere"+(cur==="cohere"?" ✅":""), callback_data: "cohere" }],
        [{ text: "Claude (Anthropic)"+(cur==="claude"?" ✅":"")+(anthropic?"":" 🔒"), callback_data: "claude" }],
      ]}
    });
  }
 
  if (text === "📋 Vazifalar") {
    return bot.sendMessage(id, "Vazifani tanlang:", {
      reply_markup: { inline_keyboard: [
        [{ text: "Matn yozish ✍️", callback_data: "tw" }],
        [{ text: "Tarjima 🌐", callback_data: "tt" }],
        [{ text: "Kod yozish 💻", callback_data: "tc" }],
        [{ text: "Xulosa 📝", callback_data: "ts" }],
        [{ text: "Matematika 🧮", callback_data: "tm2" }],
        [{ text: "G'oya 💡", callback_data: "ti" }],
        [{ text: "Tushuntirish 📖", callback_data: "te" }],
      ]}
    });
  }
 
  if (text === "📊 Hisobim") {
    const u = getUser(id);
    const prem = isPremium(id);
    const d = daysLeft(id);
    const until = u.premiumUntil ? new Date(u.premiumUntil).toLocaleDateString() : "-";
    return bot.sendMessage(id,
      "Hisobingiz:\n\n" +
      "Ism: " + (u.name||"-") + "\n" +
      "ID: " + id + "\n" +
      "Status: " + (prem ? "Premium 💎" : "Bepul") + "\n" +
      (prem ? "Muddat: "+until : "Qoldi: "+d+" kun") + "\n" +
      "Xabarlar: " + (u.count||0)
    );
  }
 
  if (text === "💎 Premium") return showPremium(id, id);
 
  if (text === "ℹ️ Yordam") {
    return bot.sendMessage(id,
      "Yordam:\n\n" +
      "🤖 Savol berish - AI ga savol yuboring\n" +
      "⚙️ AI tanlash - Groq, Cohere yoki Claude\n" +
      "🎨 Rasm yaratish - matndan rasm (/rasm <tavsif>)\n" +
      "🎬 Video yaratish - matndan video (/video <tavsif>)\n" +
      "🖼 Rasm yuboring - Claude rasm haqida savolga javob beradi\n" +
      "📋 Vazifalar - tayyor vazifalar\n" +
      "📊 Hisobim - profil\n" +
      "💎 Premium - cheksiz foydalanish\n\n" +
      "Kanal: "+CHANNEL+"\n" +
      "Muammo: /reset"
    );
  }
 
  // Rasm / Video yaratish so'rovini bajarish (tugmadan keyin yozilgan matn)
  const act = pendingAction.get(id);
  if (act) {
    pendingAction.delete(id);
    if (act === "image") return handleImageGen(id, text, msg.from.first_name, msg.from.username);
    if (act === "video") return handleVideoGen(id, text, msg.from.first_name, msg.from.username);
  }

  // AI javob
  const model = models.get(id) || "groq";
  setUser(id, { name: msg.from.first_name||"", username: msg.from.username||"", lastMsg: new Date().toISOString() });
  addMsg(id, msg.from.first_name||"", msg.from.username||"", text, model);
  const u = getUser(id);
  setUser(id, { count: (u.count||0)+1 });
 
  bot.sendChatAction(id, "typing");
 
  if (!histories.has(id)) histories.set(id, []);
  const hist = histories.get(id);
 
  try {
    let reply = "";
 
    const premNote = premiumNote(id);

    if (model === "claude" && anthropic) {
      reply = await askClaude(text, hist, SYSTEM_PROMPT + premNote, null);
      hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: reply });
    } else if (model === "cohere") {
      const ch = hist.map(h => ({ role: h.role==="user"?"USER":"CHATBOT", message: h.content }));
      const res = await cohere.chat({ model: "command-a-03-2025", message: text, chatHistory: ch, preamble: SYSTEM_PROMPT + premNote });
      reply = res.text;
      hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: reply });
    } else {
      hist.push({ role: "user", content: text });
      const sys = { role: "system", content: SYSTEM_PROMPT + premNote };
      const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [sys, ...hist], max_tokens: 1024 });
      reply = res.choices[0].message.content;
      hist.push({ role: "assistant", content: reply });
    }
 
    const d = daysLeft(id);
    if (!isPremium(id) && d <= 3 && d > 0) reply += "\n\nEslatma: " + d + " kun bepul qoldi! /premium";
 
    const chunks = reply.match(/.{1,4000}/gs) || [];
    for (const chunk of chunks) await bot.sendMessage(id, chunk);
 
  } catch (err) {
    console.error("Xato:", err.message);
    await bot.sendMessage(id, "Xatolik yuz berdi. /reset yozing.");
  }
});
 
function showPremium(chatId, userId) {
  if (isPremium(userId)) {
    const u = getUser(userId);
    const until = u.premiumUntil ? new Date(u.premiumUntil).toLocaleDateString() : "Cheksiz";
    return bot.sendMessage(chatId, "🌟 Siz Premium obunachisiz!\nMuddat: " + until + " gacha");
  }
  bot.sendMessage(chatId,
    "💎 Premium obuna\n\n" +
    "Imtiyozlar:\n" +
    "• Cheksiz so'rov (limit yo'q)\n" +
    "• Eng kuchli modellar ustuvorligi\n" +
    "• Uzun suhbatlar va chuqur yordam\n" +
    "• Birinchi navbatda javob berish\n\n" +
    "Tarifni tanlang:",
    { reply_markup: { inline_keyboard: [
      [{ text: "1 oy — 14 999 so'm", callback_data: "plan_1" }],
      [{ text: "3 oy — 39 999 so'm", callback_data: "plan_3" }],
      [{ text: "4 oy — 49 999 so'm", callback_data: "plan_4" }],
      [{ text: "5 oy — 59 999 so'm", callback_data: "plan_5" }],
      [{ text: "6 oy — 69 999 so'm", callback_data: "plan_6" }],
      [{ text: "12 oy — 119 999 so'm", callback_data: "plan_12" }],
      [{ text: "⭐ Telegram Stars", callback_data: "pay_stars" }],
    ]}}
  );
}
 
bot.on("pre_checkout_query", q => bot.answerPreCheckoutQuery(q.id, true));
bot.on("successful_payment", msg => {
  const id = msg.from.id;
  const until = new Date(); until.setMonth(until.getMonth()+1);
  setUser(id, { premium: true, premiumUntil: until.toISOString() });
  bot.sendMessage(id, "Premium faollashtirildi! 1 oy cheksiz foydalaning!");
  if (ADMIN_ID) bot.sendMessage(ADMIN_ID, "Stars to'lov! ID: "+id);
});
 
console.log("Bot ishga tushdi!");
 
