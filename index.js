require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const { CohereClient } = require("cohere-ai");
const fs = require("fs");
 
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const COHERE_KEY = process.env.COHERE_API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const CHANNEL = process.env.REQUIRED_CHANNEL || "@ustozaka_ai";
const FREE_DAYS = 20;
const PREMIUM_SOM = 15000;
const STARS = 50;
const DB = "db.json";
 
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
const histories = new Map();
const models = new Map();
 
async function subOk(id) {
  try {
    const m = await bot.getChatMember(CHANNEL, id);
    return ["member","administrator","creator"].includes(m.status);
  } catch { return false; }
}
 
const MENU = {
  keyboard: [
    [{ text: "🤖 Savol berish" }, { text: "⚙️ AI tanlash" }],
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
 
  if (data === "pay_payme") {
    bot.answerCallbackQuery(q.id);
    bot.sendMessage(q.message.chat.id, "Payme orqali to'lash:\nhttps://checkout.paycom.uz/"+process.env.PAYME_MERCHANT_ID+"\n\nTo'lovdan keyin /paid yuboring!");
    return;
  }
  if (data === "pay_click") {
    bot.answerCallbackQuery(q.id);
    bot.sendMessage(q.message.chat.id, "Click orqali to'lash:\nhttps://my.click.uz/services/pay?service_id="+process.env.CLICK_MERCHANT_ID+"&amount="+PREMIUM_SOM+"&transaction_param="+id+"\n\nTo'lovdan keyin /paid yuboring!");
    return;
  }
  if (data === "pay_stars") {
    bot.answerCallbackQuery(q.id);
    await bot.sendInvoice(q.message.chat.id, "Premium obuna", "1 oylik cheksiz foydalanish", "prem_"+id, "XTR", [{ label: "1 oy Premium", amount: STARS }]);
    return;
  }
 
  if (data.startsWith("giveprem_") && id === ADMIN_ID) {
    const tid = parseInt(data.replace("giveprem_",""));
    const until = new Date(); until.setMonth(until.getMonth()+1);
    setUser(tid, { premium: true, premiumUntil: until.toISOString() });
    bot.answerCallbackQuery(q.id, { text: "Premium berildi!" });
    bot.sendMessage(q.message.chat.id, tid+" ga Premium berildi!");
    bot.sendMessage(tid, "Premium faollashtirildi! 1 oy cheksiz foydalaning!");
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
  if (text === "🤖 Savol berish") return bot.sendMessage(id, "Savolingizni yozing!", { reply_markup: MENU });
 
  if (text === "⚙️ AI tanlash") {
    const cur = models.get(id) || "groq";
    return bot.sendMessage(id, "Qaysi AI ni tanlaysiz?", {
      reply_markup: { inline_keyboard: [
        [{ text: "Groq (Llama 3.3)"+(cur==="groq"?" ✅":""), callback_data: "groq" }],
        [{ text: "Cohere"+(cur==="cohere"?" ✅":""), callback_data: "cohere" }],
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
      "Savol berish - AI ga savol yuboring\n" +
      "AI tanlash - Groq yoki Cohere\n" +
      "Vazifalar - tayyor vazifalar\n" +
      "Hisobim - profil\n" +
      "Premium - cheksiz foydalanish\n\n" +
      "Kanal: "+CHANNEL+"\n" +
      "Muammo: /reset"
    );
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
 
    if (model === "cohere") {
      const ch = hist.map(h => ({ role: h.role==="user"?"USER":"CHATBOT", message: h.content }));
      const res = await cohere.chat({ model: "command-a-03-2025", message: text, chatHistory: ch });
      reply = res.text;
      hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: reply });
    } else {
      hist.push({ role: "user", content: text });
      const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: hist, max_tokens: 1024 });
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
    return bot.sendMessage(chatId, "Siz Premium foydalanuvchisiz!\nMuddat: "+until);
  }
  bot.sendMessage(chatId,
    "Premium obuna - 1 oy\n\nCheksiz savollar\nGroq + Cohere AI\n\nNarx: "+PREMIUM_SOM.toLocaleString()+" so'm\n\nTo'lov usulini tanlang:",
    { reply_markup: { inline_keyboard: [
      [{ text: "Payme", callback_data: "pay_payme" }],
      [{ text: "Click", callback_data: "pay_click" }],
      [{ text: "Telegram Stars", callback_data: "pay_stars" }],
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
 
