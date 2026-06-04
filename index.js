// ============================================================
//  Ustoz AKA AI — Telegram bot (yangilangan, kuchaytirilgan)
//  Imkoniyatlar: AI chat (Groq/Cohere), rasm yaratish, rasm tahlili,
//  ovozni matnga aylantirish, chek bilan to'lov, referal, admin panel.
// ============================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const config = require("./src/config");
const db = require("./src/db");
const ai = require("./src/ai");
const kb = require("./src/keyboards");

// ---- Token tekshiruvi ----
if (!config.BOT_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN topilmadi! .env faylini to'ldiring.");
  process.exit(1);
}

const bot = new TelegramBot(config.BOT_TOKEN, {
  polling: { interval: 300, autoStart: true, params: { timeout: 30 } },
});

// Vaqtinchalik holatlar (rasm/chek kutilmoqda) — xotirada
const state = new Map(); // userId -> { type: 'image'|'receipt', method?, t }
// Suhbat tarixi — xotirada
const histories = new Map(); // userId -> [{role, content}]

let BOT_USERNAME = "";

// ============================================================
//  YORDAMCHI FUNKSIYALAR
// ============================================================
function isAdmin(id) {
  return id === config.ADMIN_ID;
}

function isPremium(id) {
  if (isAdmin(id)) return true;
  const u = db.getUser(id);
  return !!(u.premium && u.premiumUntil && new Date(u.premiumUntil) > new Date());
}

function daysLeft(id) {
  const u = db.getUser(id);
  const elapsed = (Date.now() - new Date(u.joined).getTime()) / 86400000;
  return Math.max(0, config.FREE_DAYS + (u.bonusDays || 0) - Math.floor(elapsed));
}

function canUse(id) {
  if (isAdmin(id) || isPremium(id)) return true;
  return daysLeft(id) > 0;
}

function canGenerateImage(id) {
  if (isAdmin(id) || isPremium(id)) return { ok: true };
  if (!canUse(id)) return { ok: false, reason: "trial" };
  const u = db.getUser(id);
  const today = new Date().toDateString();
  const used = u.imageDay === today ? u.imageDayCount || 0 : 0;
  if (used >= config.FREE_IMAGE_PER_DAY) return { ok: false, reason: "daily", used };
  return { ok: true };
}

function markImageUse(id) {
  const u = db.getUser(id);
  const today = new Date().toDateString();
  const used = u.imageDay === today ? u.imageDayCount || 0 : 0;
  db.setUser(id, { imageDay: today, imageDayCount: used + 1, imageCount: (u.imageCount || 0) + 1 });
  db.incImageStat();
}

async function subOk(id) {
  if (isAdmin(id)) return true;
  try {
    const m = await bot.getChatMember(config.CHANNEL, id);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch {
    return false;
  }
}

async function safeSend(chatId, text, options) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (e) {
    console.error("[send] xato:", chatId, e.message);
    return null;
  }
}

async function sendLong(chatId, text, options) {
  const chunks = text.match(new RegExp(`[\\s\\S]{1,${config.MAX_MSG_LEN}}`, "g")) || [""];
  for (let i = 0; i < chunks.length; i++) {
    await safeSend(chatId, chunks[i], i === chunks.length - 1 ? options : undefined);
  }
}

function grantPremium(userId, months) {
  const u = db.getUser(userId);
  const base = isPremium(userId) && u.premiumUntil ? new Date(u.premiumUntil) : new Date();
  base.setMonth(base.getMonth() + (months || config.PREMIUM_MONTHS));
  db.setUser(userId, { premium: true, premiumUntil: base.toISOString() });
  return base;
}

function getHistory(id) {
  if (!histories.has(id)) histories.set(id, []);
  return histories.get(id);
}

function pushHistory(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  // tarixni cheklash
  while (h.length > config.HISTORY_LIMIT) h.shift();
}

// Obuna talab qiluvchi to'siq. true qaytsa — to'xtatish kerak.
async function gateSubscription(id) {
  if (await subOk(id)) return false;
  await safeSend(
    id,
    "❗️ Botdan foydalanish uchun avval kanalga obuna bo'ling va Instagram'da follow qiling, so'ng tekshiring:",
    { reply_markup: kb.subscribeKeyboard() }
  );
  return true;
}

// ============================================================
//  /start  (+ referal)
// ============================================================
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  try {
    const id = msg.from.id;
    if (msg.chat.type !== "private") return;
    const name = msg.from.first_name || "Do'stim";
    const payload = (match && match[1] ? match[1] : "").trim();

    const existedBefore = !!db.loadDB().users[id];
    db.setUser(id, { name, username: msg.from.username || "" });

    // Referal hisoblash (faqat yangi foydalanuvchi uchun)
    if (!existedBefore && payload) {
      const refId = parseInt(payload.replace(/\D/g, ""), 10);
      if (refId && refId !== id && db.loadDB().users[refId]) {
        const ref = db.getUser(refId);
        const refs = Array.isArray(ref.referrals) ? ref.referrals : [];
        if (!refs.includes(id)) {
          refs.push(id);
          db.setUser(refId, { referrals: refs, bonusDays: (ref.bonusDays || 0) + config.REFERRAL_BONUS_DAYS });
          db.setUser(id, { referredBy: refId });
          safeSend(
            refId,
            `🎉 Sizning havolangiz orqali yangi do'st qo'shildi!\n+${config.REFERRAL_BONUS_DAYS} kun bepul muddat berildi.`
          );
        }
      }
    }

    const u = db.getUser(id);
    if (u.banned) return;

    if (await gateSubscription(id)) return;

    const prem = isPremium(id);
    await safeSend(
      id,
      `👋 Salom, ${name}! Xush kelibsiz!\n\n` +
        `Men "Ustoz AKA AI" — savollaringizga javob beraman, rasm yarataman, ` +
        `rasm va ovozli xabarlarni tahlil qilaman.\n\n` +
        (prem ? "💎 Premium faol — cheksiz foydalaning!" : `🎁 Bepul muddat: ${daysLeft(id)} kun qoldi`) +
        "\n\nQuyidagi menyudan tanlang 👇",
      { reply_markup: kb.mainMenu }
    );
  } catch (e) {
    console.error("[/start]", e.message);
  }
});

// ============================================================
//  Oddiy buyruqlar
// ============================================================
bot.onText(/^\/reset$/, (msg) => {
  histories.delete(msg.from.id);
  state.delete(msg.from.id);
  safeSend(msg.chat.id, "🧹 Suhbat tarixi tozalandi!", { reply_markup: kb.mainMenu });
});

bot.onText(/^\/cancel$/, (msg) => {
  state.delete(msg.from.id);
  safeSend(msg.chat.id, "✖️ Bekor qilindi.", { reply_markup: kb.mainMenu });
});

bot.onText(/^\/premium$/, (msg) => showPremium(msg.chat.id, msg.from.id));

bot.onText(/^\/help$/, (msg) => showHelp(msg.chat.id));

bot.onText(/^\/image\s+(.+)$/s, async (msg, match) => {
  if (msg.chat.type !== "private") return;
  if (await gateSubscription(msg.from.id)) return;
  await handleImageRequest(msg.from.id, match[1]);
});

// ============================================================
//  ADMIN buyruqlari
// ============================================================
bot.onText(/^\/admin$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  safeSend(msg.chat.id, "🛠 Admin panel:", { reply_markup: kb.adminPanel });
});

bot.onText(/^\/stats$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  safeSend(msg.chat.id, statsText());
});

bot.onText(/^\/users$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  safeSend(msg.chat.id, usersText());
});

bot.onText(/^\/messages$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  safeSend(msg.chat.id, messagesText());
});

bot.onText(/^\/pending$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  safeSend(msg.chat.id, pendingText());
});

bot.onText(/^\/find\s+(.+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const q = match[1].trim().toLowerCase();
  const found = db.allUsers().filter(
    (u) =>
      String(u.id).includes(q) ||
      (u.username || "").toLowerCase().includes(q) ||
      (u.name || "").toLowerCase().includes(q)
  );
  if (!found.length) return safeSend(msg.chat.id, "Topilmadi.");
  let t = "🔎 Topildi:\n\n";
  found.slice(0, 20).forEach((u) => {
    t += `${isPremium(u.id) ? "💎" : "🆓"} ${u.name || "-"} @${u.username || "yo'q"} | ${u.id} | ${u.count || 0} xabar\n`;
  });
  safeSend(msg.chat.id, t);
});

bot.onText(/^\/givepremium\s+(\d+)(?:\s+(\d+))?$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tid = parseInt(match[1], 10);
  const months = match[2] ? parseInt(match[2], 10) : config.PREMIUM_MONTHS;
  const until = grantPremium(tid, months);
  safeSend(msg.chat.id, `✅ ${tid} ga ${months} oy Premium berildi. Tugash: ${until.toLocaleDateString()}`);
  safeSend(tid, `💎 Sizga Premium faollashtirildi! Muddat: ${until.toLocaleDateString()}`);
});

bot.onText(/^\/revoke\s+(\d+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tid = parseInt(match[1], 10);
  db.setUser(tid, { premium: false, premiumUntil: null });
  safeSend(msg.chat.id, `🚫 ${tid} dan Premium olib tashlandi.`);
});

bot.onText(/^\/adddays\s+(\d+)\s+(\d+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tid = parseInt(match[1], 10);
  const days = parseInt(match[2], 10);
  const u = db.getUser(tid);
  db.setUser(tid, { bonusDays: (u.bonusDays || 0) + days });
  safeSend(msg.chat.id, `✅ ${tid} ga +${days} kun qo'shildi.`);
  safeSend(tid, `🎁 Sizga +${days} kun bepul muddat berildi!`);
});

bot.onText(/^\/ban\s+(\d+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tid = parseInt(match[1], 10);
  db.setUser(tid, { banned: true });
  safeSend(msg.chat.id, `🚫 ${tid} bloklandi.`);
});

bot.onText(/^\/unban\s+(\d+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tid = parseInt(match[1], 10);
  db.setUser(tid, { banned: false });
  safeSend(msg.chat.id, `✅ ${tid} blokdan chiqarildi.`);
});

bot.onText(/^\/broadcast\s+([\s\S]+)$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await broadcast(msg.chat.id, { text: match[1] });
});

// ============================================================
//  CALLBACK QUERY
// ============================================================
bot.on("callback_query", async (q) => {
  try {
    const id = q.from.id;
    const data = q.data || "";
    const chatId = q.message ? q.message.chat.id : id;

    // Obunani tekshirish
    if (data === "checksub") {
      if (await subOk(id)) {
        bot.answerCallbackQuery(q.id, { text: "✅ Tasdiqlandi!" });
        try { await bot.deleteMessage(chatId, q.message.message_id); } catch {}
        await safeSend(
          id,
          `✅ Obuna tasdiqlandi!\n\n🎁 Bepul muddat: ${daysLeft(id)} kun\n\nMenyudan foydalaning:`,
          { reply_markup: kb.mainMenu }
        );
      } else {
        bot.answerCallbackQuery(q.id, { text: "❌ Hali to'liq obuna bo'lmadingiz!", show_alert: true });
      }
      return;
    }

    // AI model tanlash
    if (data.startsWith("model_")) {
      const m = data.replace("model_", "");
      db.setUser(id, { model: m });
      histories.delete(id);
      bot.answerCallbackQuery(q.id, { text: "AI tanlandi!" });
      const labels = { groq: "Llama 3.3 70B", fast: "Llama 3.1 8B (tezkor)", cohere: "Cohere Command" };
      await safeSend(chatId, `✅ Tanlandi: ${labels[m] || m}`);
      return;
    }

    // Vazifa promptlari
    if (data.startsWith("task_")) {
      const key = data.replace("task_", "");
      bot.answerCallbackQuery(q.id);
      if (kb.TASK_PROMPTS[key]) await safeSend(chatId, kb.TASK_PROMPTS[key]);
      return;
    }

    // To'lov usullari
    if (data === "pay_card") {
      bot.answerCallbackQuery(q.id);
      state.set(id, { type: "receipt", method: "Karta", t: Date.now() });
      await safeSend(
        chatId,
        `💳 Karta orqali to'lov:\n\n` +
          `Karta: <code>${config.CARD_NUMBER}</code>\n` +
          `Egasi: ${config.CARD_HOLDER}\n` +
          `Summa: ${config.PREMIUM_SOM.toLocaleString()} so'm\n\n` +
          `➡️ To'lovni amalga oshirgach, CHEK (skrinshot yoki rasm) ni shu yerga yuboring. ` +
          `Admin tekshirib, Premium faollashtiradi.`,
        { parse_mode: "HTML" }
      );
      return;
    }
    if (data === "pay_payme") {
      bot.answerCallbackQuery(q.id);
      state.set(id, { type: "receipt", method: "Payme", t: Date.now() });
      await safeSend(
        chatId,
        `🔵 Payme orqali to'lash:\nhttps://checkout.paycom.uz/${config.PAYME_MERCHANT_ID}\n\n` +
          `Summa: ${config.PREMIUM_SOM.toLocaleString()} so'm\n\n➡️ To'lovdan keyin CHEKni shu yerga yuboring.`
      );
      return;
    }
    if (data === "pay_click") {
      bot.answerCallbackQuery(q.id);
      state.set(id, { type: "receipt", method: "Click", t: Date.now() });
      await safeSend(
        chatId,
        `🟢 Click orqali to'lash:\n` +
          `https://my.click.uz/services/pay?service_id=${config.CLICK_MERCHANT_ID}&amount=${config.PREMIUM_SOM}&transaction_param=${id}\n\n` +
          `➡️ To'lovdan keyin CHEKni shu yerga yuboring.`
      );
      return;
    }
    if (data === "pay_stars") {
      bot.answerCallbackQuery(q.id);
      try {
        await bot.sendInvoice(
          chatId,
          "Premium obuna",
          `${config.PREMIUM_MONTHS} oylik cheksiz foydalanish`,
          "prem_" + id,
          "XTR",
          [{ label: "Premium", amount: config.STARS }]
        );
      } catch (e) {
        await safeSend(chatId, "Stars to'lovini boshlashda xatolik. Boshqa usulni tanlang.");
      }
      return;
    }

    // Admin: to'lovni tasdiqlash / rad etish
    if (data.startsWith("payok_") && isAdmin(id)) {
      const pid = data.replace("payok_", "");
      const p = db.getPayment(pid);
      if (!p) { bot.answerCallbackQuery(q.id, { text: "Topilmadi" }); return; }
      if (p.status !== "pending") { bot.answerCallbackQuery(q.id, { text: "Allaqachon ko'rib chiqilgan" }); return; }
      db.setPaymentStatus(pid, "approved");
      const until = grantPremium(p.userId, config.PREMIUM_MONTHS);
      bot.answerCallbackQuery(q.id, { text: "✅ Tasdiqlandi" });
      await safeSend(chatId, `✅ To'lov tasdiqlandi. ${p.userId} ga Premium berildi.`);
      await safeSend(p.userId, `🎉 To'lovingiz tasdiqlandi! 💎 Premium faol.\nMuddat: ${until.toLocaleDateString()}`);
      return;
    }
    if (data.startsWith("payno_") && isAdmin(id)) {
      const pid = data.replace("payno_", "");
      const p = db.getPayment(pid);
      if (!p) { bot.answerCallbackQuery(q.id, { text: "Topilmadi" }); return; }
      if (p.status !== "pending") { bot.answerCallbackQuery(q.id, { text: "Allaqachon ko'rib chiqilgan" }); return; }
      db.setPaymentStatus(pid, "rejected");
      bot.answerCallbackQuery(q.id, { text: "❌ Rad etildi" });
      await safeSend(chatId, `❌ To'lov rad etildi (${p.userId}).`);
      await safeSend(p.userId, "❌ To'lovingiz tasdiqlanmadi. To'g'ri chek yuboring yoki admin bilan bog'laning.");
      return;
    }

    // Admin panel tugmalari
    if (data === "adm_stats" && isAdmin(id)) { bot.answerCallbackQuery(q.id); await safeSend(chatId, statsText()); return; }
    if (data === "adm_users" && isAdmin(id)) { bot.answerCallbackQuery(q.id); await safeSend(chatId, usersText()); return; }
    if (data === "adm_msgs" && isAdmin(id)) { bot.answerCallbackQuery(q.id); await safeSend(chatId, messagesText()); return; }
    if (data === "adm_pending" && isAdmin(id)) { bot.answerCallbackQuery(q.id); await safeSend(chatId, pendingText()); return; }

    bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error("[callback]", e.message);
    try { bot.answerCallbackQuery(q.id); } catch {}
  }
});

// ============================================================
//  ASOSIY XABAR HANDLER
// ============================================================
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.from) return;
    if (msg.chat.type !== "private") return;
    const id = msg.from.id;

    // Buyruqlar onText orqali ishlanadi
    if (msg.text && msg.text.startsWith("/")) return;

    const user = db.getUser(id);
    if (user.banned && !isAdmin(id)) return;

    // --- Admin ommaviy media yuborishi ---
    if (isAdmin(id) && (msg.photo || msg.video) && msg.caption) {
      if (msg.caption.startsWith("/sendphoto")) {
        await broadcast(id, { photo: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption.replace("/sendphoto", "").trim() });
        return;
      }
      if (msg.caption.startsWith("/sendvideo")) {
        await broadcast(id, { video: msg.video.file_id, caption: msg.caption.replace("/sendvideo", "").trim() });
        return;
      }
    }

    // --- Obuna to'sig'i ---
    if (await gateSubscription(id)) return;

    db.setUser(id, { name: msg.from.first_name || "", username: msg.from.username || "", lastMsg: new Date().toISOString() });

    // --- CHEK (rasm) — to'lov holatida ---
    const st = state.get(id);
    if (msg.photo && st && st.type === "receipt") {
      await handleReceipt(msg, st);
      state.delete(id);
      return;
    }

    // --- Ovozli xabar ---
    if (msg.voice || msg.audio) {
      await handleVoice(msg);
      return;
    }

    // --- Rasm yuborildi -> tahlil (vision) ---
    if (msg.photo) {
      await handleVision(msg);
      return;
    }

    if (!msg.text) return;
    const text = msg.text.trim();

    // --- Menyu tugmalari ---
    const MENU_BUTTONS = [
      "🤖 Savol berish", "🎨 Rasm yaratish", "📋 Vazifalar", "⚙️ AI tanlash",
      "📊 Hisobim", "💎 Premium", "👥 Do'st taklif qilish", "ℹ️ Yordam",
    ];
    if (MENU_BUTTONS.includes(text)) {
      state.delete(id); // menyu bosilsa har qanday kutish holatini bekor qilamiz
      return handleMenu(id, text);
    }

    // --- Rasm yaratish holati ---
    if (st && st.type === "image") {
      state.delete(id);
      return handleImageRequest(id, text);
    }

    // --- Aks holda: AI chat ---
    if (!canUse(id)) return sendLimitMessage(id);
    await handleChat(msg, text);
  } catch (e) {
    console.error("[message]", e.message);
  }
});

// ============================================================
//  MENYU
// ============================================================
async function handleMenu(id, text) {
  switch (text) {
    case "🤖 Savol berish":
      return safeSend(id, "✍️ Savolingizni yozing, men javob beraman!", { reply_markup: kb.mainMenu });

    case "🎨 Rasm yaratish": {
      const chk = canGenerateImage(id);
      if (!chk.ok) return sendImageLimit(id, chk);
      state.set(id, { type: "image", t: Date.now() });
      return safeSend(id, "🎨 Qanday rasm yaratay? Tasvirlab yozing.\nMasalan: tog' cho'qqisidagi quyosh chiqishi, realistik.");
    }

    case "📋 Vazifalar":
      return safeSend(id, "📋 Vazifani tanlang:", { reply_markup: kb.tasksKeyboard });

    case "⚙️ AI tanlash": {
      const u = db.getUser(id);
      return safeSend(id, "⚙️ Qaysi AI modelidan foydalanasiz?", { reply_markup: kb.aiSelectKeyboard(u.model || "groq") });
    }

    case "📊 Hisobim": {
      const u = db.getUser(id);
      const prem = isPremium(id);
      const until = u.premiumUntil ? new Date(u.premiumUntil).toLocaleDateString() : "-";
      return safeSend(
        id,
        "📊 Hisobingiz:\n\n" +
          `👤 Ism: ${u.name || "-"}\n` +
          `🆔 ID: ${id}\n` +
          `📌 Status: ${prem ? "Premium 💎" : "Bepul 🆓"}\n` +
          (prem ? `📅 Muddat: ${until}\n` : `🎁 Qoldi: ${daysLeft(id)} kun\n`) +
          `💬 Xabarlar: ${u.count || 0}\n` +
          `🎨 Rasmlar: ${u.imageCount || 0}\n` +
          `👥 Takliflar: ${(u.referrals || []).length}`,
        { reply_markup: kb.mainMenu }
      );
    }

    case "💎 Premium":
      return showPremium(id, id);

    case "👥 Do'st taklif qilish": {
      const u = db.getUser(id);
      const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${id}` : `(bot ishga tushmoqda...)`;
      return safeSend(
        id,
        "👥 Do'stlaringizni taklif qiling!\n\n" +
          `Har bir do'st sizning havolangiz orqali qo'shilsa, sizga +${config.REFERRAL_BONUS_DAYS} kun bepul muddat beriladi.\n\n` +
          `🔗 Havolangiz:\n${link}\n\n` +
          `✅ Hozircha takliflar: ${(u.referrals || []).length}`,
        { reply_markup: kb.mainMenu }
      );
    }

    case "ℹ️ Yordam":
      return showHelp(id);
  }
}

// ============================================================
//  CHAT (AI matnli javob)
// ============================================================
async function handleChat(msg, text) {
  const id = msg.from.id;
  const u = db.getUser(id);
  const model = u.model || "groq";

  db.addMsg({ id, name: msg.from.first_name || "", uname: msg.from.username || "", text, model });
  db.setUser(id, { count: (u.count || 0) + 1 });

  bot.sendChatAction(id, "typing");
  const history = getHistory(id);

  try {
    const reply = await ai.chat({ model, text, history });
    pushHistory(id, "user", text);
    pushHistory(id, "assistant", reply);

    let out = reply || "Kechirasiz, javob bo'sh keldi. /reset yozib ko'ring.";
    const d = daysLeft(id);
    if (!isPremium(id) && d > 0 && d <= 3) out += `\n\n⏳ Eslatma: bepul muddat tugashiga ${d} kun qoldi. /premium`;
    await sendLong(id, out, { reply_markup: kb.mainMenu });
  } catch (e) {
    console.error("[chat]", e.message);
    await safeSend(id, "⚠️ AI javob berishda xatolik yuz berdi. Birozdan keyin urinib ko'ring yoki /reset yozing.");
  }
}

// ============================================================
//  RASM YARATISH
// ============================================================
async function handleImageRequest(id, prompt) {
  const chk = canGenerateImage(id);
  if (!chk.ok) return sendImageLimit(id, chk);

  bot.sendChatAction(id, "upload_photo");
  const wait = await safeSend(id, "🎨 Rasm yaratilmoqda... (15-40 soniya)");
  try {
    const { buffer, prompt: used } = await ai.generateImage(prompt);
    markImageUse(id);
    db.addMsg({ id, name: "", uname: "", text: "[rasm] " + prompt, model: "image" });
    await bot.sendPhoto(
      id,
      buffer,
      { caption: "🎨 " + prompt.slice(0, 200), reply_markup: kb.mainMenu },
      { filename: "image.png", contentType: "image/png" }
    );
    if (wait) try { await bot.deleteMessage(id, wait.message_id); } catch {}
  } catch (e) {
    console.error("[image]", e.message);
    if (wait) try { await bot.deleteMessage(id, wait.message_id); } catch {}
    await safeSend(id, "⚠️ Rasm yaratib bo'lmadi. Boshqacharoq tasvirlab ko'ring yoki keyinroq urinib ko'ring.");
  }
}

// ============================================================
//  VISION — yuborilgan rasmni tahlil qilish
// ============================================================
async function handleVision(msg) {
  const id = msg.from.id;
  if (!canUse(id)) return sendLimitMessage(id);
  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const link = await bot.getFileLink(fileId);
    bot.sendChatAction(id, "typing");
    const question = (msg.caption || "").trim();
    const answer = await ai.analyzeImage(link, question);
    db.addMsg({ id, name: msg.from.first_name || "", uname: msg.from.username || "", text: "[rasm tahlili] " + question, model: "vision" });
    await sendLong(id, "🖼 " + (answer || "Rasmni tahlil qila olmadim."), { reply_markup: kb.mainMenu });
  } catch (e) {
    console.error("[vision]", e.message);
    await safeSend(id, "⚠️ Rasmni tahlil qilishda xatolik. Keyinroq urinib ko'ring.");
  }
}

// ============================================================
//  VOICE — ovozni matnga aylantirib, javob berish
// ============================================================
async function handleVoice(msg) {
  const id = msg.from.id;
  if (!canUse(id)) return sendLimitMessage(id);
  const fileId = (msg.voice || msg.audio).file_id;
  let filePath = null;
  try {
    bot.sendChatAction(id, "typing");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-"));
    filePath = await bot.downloadFile(fileId, dir);
    const text = await ai.transcribe(filePath);
    if (!text) {
      await safeSend(id, "🎤 Ovozdan matn ajratib bo'lmadi. Aniqroq gapiring.");
      return;
    }
    await safeSend(id, "🎤 Eshitdim: " + text);
    if (!canUse(id)) return sendLimitMessage(id);
    await handleChat(msg, text);
  } catch (e) {
    console.error("[voice]", e.message);
    await safeSend(id, "⚠️ Ovozli xabarni qayta ishlashda xatolik.");
  } finally {
    if (filePath) { try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {} }
  }
}

// ============================================================
//  CHEK (to'lov) qabul qilish
// ============================================================
async function handleReceipt(msg, st) {
  const id = msg.from.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const payment = db.addPayment({
    userId: id,
    name: msg.from.first_name || "",
    username: msg.from.username || "",
    method: st.method || "Karta",
    amount: config.PREMIUM_SOM,
    fileId,
  });

  await safeSend(id, "✅ Chek qabul qilindi! Admin tez orada tekshirib, Premium faollashtiradi. Sabr qiling 🙏");

  if (config.ADMIN_ID) {
    const cap =
      "🧾 Yangi to'lov cheki!\n\n" +
      `👤 ${msg.from.first_name || "-"} @${msg.from.username || "yo'q"}\n` +
      `🆔 ${id}\n` +
      `💳 Usul: ${st.method || "Karta"}\n` +
      `💰 Summa: ${config.PREMIUM_SOM.toLocaleString()} so'm`;
    try {
      await bot.sendPhoto(config.ADMIN_ID, fileId, {
        caption: cap,
        reply_markup: kb.paymentReviewKeyboard(id, payment.pid),
      });
    } catch (e) {
      console.error("[receipt->admin]", e.message);
    }
  }
}

// ============================================================
//  PREMIUM / YORDAM / LIMIT xabarlari
// ============================================================
function showPremium(chatId, userId) {
  if (isPremium(userId)) {
    const u = db.getUser(userId);
    const until = u.premiumUntil ? new Date(u.premiumUntil).toLocaleDateString() : "Cheksiz";
    return safeSend(chatId, `💎 Siz Premium foydalanuvchisiz!\n📅 Muddat: ${until}`, { reply_markup: kb.mainMenu });
  }
  safeSend(
    chatId,
    "💎 PREMIUM OBUNA\n\n" +
      "✅ Cheksiz savollar\n" +
      "✅ Cheksiz rasm yaratish\n" +
      "✅ Rasm va ovoz tahlili\n" +
      "✅ Barcha AI modellar\n\n" +
      `💰 Narx: ${config.PREMIUM_SOM.toLocaleString()} so'm / ${config.PREMIUM_MONTHS} oy\n\n` +
      "To'lov usulini tanlang 👇",
    { reply_markup: kb.premiumKeyboard() }
  );
}

function showHelp(chatId) {
  safeSend(
    chatId,
    "ℹ️ YORDAM\n\n" +
      "🤖 Savol berish — AI ga istalgan savol bering\n" +
      "🎨 Rasm yaratish — matndan rasm yarataman\n" +
      "🖼 Rasm yuboring — uni tahlil qilaman\n" +
      "🎤 Ovozli xabar — matnga aylantirib javob beraman\n" +
      "📋 Vazifalar — tayyor yordamchilar\n" +
      "⚙️ AI tanlash — Llama yoki Cohere\n" +
      "💎 Premium — cheksiz foydalanish\n" +
      "👥 Do'st taklif qilish — bepul kun yutib oling\n\n" +
      "Buyruqlar:\n/reset — suhbatni tozalash\n/cancel — amalni bekor qilish\n/image <matn> — tez rasm\n\n" +
      `📢 Kanal: ${config.CHANNEL}`,
    { reply_markup: kb.mainMenu }
  );
}

function sendLimitMessage(id) {
  return safeSend(
    id,
    "⏳ Bepul muddatingiz tugadi!\n\nCheksiz foydalanish uchun Premium oling 👇",
    { reply_markup: kb.premiumKeyboard() }
  );
}

function sendImageLimit(id, chk) {
  if (chk.reason === "trial") return sendLimitMessage(id);
  return safeSend(
    id,
    `🎨 Bugungi bepul rasm limiti tugadi (${config.FREE_IMAGE_PER_DAY} ta/kun).\n\n` +
      "Cheksiz rasm yaratish uchun Premium oling 👇",
    { reply_markup: kb.premiumKeyboard() }
  );
}

// ============================================================
//  ADMIN matnlari
// ============================================================
function statsText() {
  const data = db.loadDB();
  const users = Object.values(data.users);
  const prem = users.filter((u) => isPremium(u.id)).length;
  const today = new Date().toDateString();
  const tm = (data.msgs || []).filter((m) => new Date(m.t).toDateString() === today).length;
  const newToday = users.filter((u) => new Date(u.joined).toDateString() === today).length;
  return (
    "📊 STATISTIKA\n\n" +
    `👥 Jami foydalanuvchi: ${users.length}\n` +
    `💎 Premium: ${prem}\n` +
    `🆓 Bepul: ${users.length - prem}\n` +
    `🆕 Bugun qo'shilgan: ${newToday}\n\n` +
    `💬 Jami xabarlar: ${data.stats.messages || 0}\n` +
    `📨 Bugungi xabarlar: ${tm}\n` +
    `🎨 Jami rasmlar: ${data.stats.images || 0}\n` +
    `🧾 Kutilayotgan to'lovlar: ${db.pendingPayments().length}`
  );
}

function usersText() {
  const users = db.allUsers().slice(-25).reverse();
  if (!users.length) return "Foydalanuvchilar yo'q.";
  let t = "👥 Oxirgi foydalanuvchilar:\n\n";
  users.forEach((u, i) => {
    t += `${i + 1}. ${isPremium(u.id) ? "💎" : "🆓"} ${u.name || "-"} @${u.username || "yo'q"} | ${u.id} | ${u.count || 0} 💬\n`;
  });
  return t;
}

function messagesText() {
  const msgs = (db.loadDB().msgs || []).slice(-15).reverse();
  if (!msgs.length) return "Xabarlar yo'q.";
  let t = "💬 Oxirgi xabarlar:\n\n";
  msgs.forEach((m, i) => {
    t += `${i + 1}. ${m.name || "-"} [${m.model}]\n${(m.text || "").slice(0, 70)}\n\n`;
  });
  return t;
}

function pendingText() {
  const ps = db.pendingPayments();
  if (!ps.length) return "🧾 Kutilayotgan to'lovlar yo'q.";
  let t = "🧾 Kutilayotgan to'lovlar:\n\n";
  ps.slice(-15).forEach((p, i) => {
    t += `${i + 1}. ${p.name || "-"} @${p.username || "yo'q"} | ${p.userId} | ${p.method} | ${new Date(p.t).toLocaleString()}\n`;
  });
  t += "\nTasdiqlash uchun chek rasmidagi tugmalardan foydalaning.";
  return t;
}

// ============================================================
//  Ommaviy yuborish (broadcast)
// ============================================================
async function broadcast(adminChatId, payload) {
  const users = db.allUsers();
  await safeSend(adminChatId, `📤 ${users.length} ta foydalanuvchiga yuborilmoqda...`);
  let s = 0, f = 0;
  for (const u of users) {
    try {
      if (payload.photo) await bot.sendPhoto(u.id, payload.photo, { caption: payload.caption || "" });
      else if (payload.video) await bot.sendVideo(u.id, payload.video, { caption: payload.caption || "" });
      else await bot.sendMessage(u.id, "📢 " + payload.text);
      s++;
    } catch {
      f++;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  await safeSend(adminChatId, `✅ Yuborildi: ${s}\n❌ Yuborilmadi: ${f}`);
}

// ============================================================
//  TO'LOV (Telegram Stars)
// ============================================================
bot.on("pre_checkout_query", (q) => {
  bot.answerPreCheckoutQuery(q.id, true).catch((e) => console.error("[pre_checkout]", e.message));
});

bot.on("successful_payment", (msg) => {
  const id = msg.from.id;
  const until = grantPremium(id, config.PREMIUM_MONTHS);
  safeSend(id, `🎉 To'lov muvaffaqiyatli! 💎 Premium faollashtirildi.\nMuddat: ${until.toLocaleDateString()}`);
  if (config.ADMIN_ID) safeSend(config.ADMIN_ID, `⭐ Stars to'lov! ID: ${id}`);
});

// ============================================================
//  XATOLARNI USHLASH
// ============================================================
bot.on("polling_error", (e) => console.error("[polling_error]", e.code || "", e.message));
bot.on("webhook_error", (e) => console.error("[webhook_error]", e.message));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e && e.message ? e.message : e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e.message));

// ============================================================
//  ISHGA TUSHIRISH
// ============================================================
(async () => {
  try {
    const me = await bot.getMe();
    BOT_USERNAME = me.username;
    await bot.setMyCommands([
      { command: "start", description: "Botni ishga tushirish" },
      { command: "premium", description: "Premium obuna" },
      { command: "image", description: "Rasm yaratish: /image <matn>" },
      { command: "reset", description: "Suhbatni tozalash" },
      { command: "cancel", description: "Amalni bekor qilish" },
      { command: "help", description: "Yordam" },
    ]).catch(() => {});
    console.log(`✅ Bot ishga tushdi: @${BOT_USERNAME}`);
    console.log(`   Groq: ${ai.hasGroq ? "✓" : "✗"} | Cohere: ${ai.hasCohere ? "✓" : "✗"} | Admin: ${config.ADMIN_ID || "yo'q"}`);
  } catch (e) {
    console.error("❌ Ishga tushirishda xato:", e.message);
  }
})();
