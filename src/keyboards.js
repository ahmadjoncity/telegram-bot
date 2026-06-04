// ============================================================
//  keyboards.js — menyular va inline tugmalar
// ============================================================
const config = require("./config");

const mainMenu = {
  keyboard: [
    [{ text: "🤖 Savol berish" }, { text: "🎨 Rasm yaratish" }],
    [{ text: "📋 Vazifalar" }, { text: "⚙️ AI tanlash" }],
    [{ text: "📊 Hisobim" }, { text: "💎 Premium" }],
    [{ text: "👥 Do'st taklif qilish" }, { text: "ℹ️ Yordam" }],
  ],
  resize_keyboard: true,
};

function subscribeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Telegram kanal", url: config.CHANNEL_URL }],
      [{ text: "📸 Instagram", url: config.INSTAGRAM_URL }],
      [{ text: "✅ Obunani tekshirish", callback_data: "checksub" }],
    ],
  };
}

function aiSelectKeyboard(current) {
  const mark = (v) => (current === v ? " ✅" : "");
  return {
    inline_keyboard: [
      [{ text: "🦙 Llama 3.3 70B (kuchli)" + mark("groq"), callback_data: "model_groq" }],
      [{ text: "⚡ Llama 3.1 8B (tezkor)" + mark("fast"), callback_data: "model_fast" }],
      [{ text: "🧠 Cohere Command" + mark("cohere"), callback_data: "model_cohere" }],
    ],
  };
}

const tasksKeyboard = {
  inline_keyboard: [
    [{ text: "✍️ Matn yozish", callback_data: "task_tw" }, { text: "🌐 Tarjima", callback_data: "task_tt" }],
    [{ text: "💻 Kod yozish", callback_data: "task_tc" }, { text: "📝 Xulosa", callback_data: "task_ts" }],
    [{ text: "🧮 Matematika", callback_data: "task_tm" }, { text: "💡 G'oya", callback_data: "task_ti" }],
    [{ text: "📖 Tushuntirish", callback_data: "task_te" }, { text: "🎓 Insho/Referat", callback_data: "task_essay" }],
  ],
};

function premiumKeyboard() {
  const rows = [[{ text: "💳 Karta orqali (chek bilan)", callback_data: "pay_card" }]];
  if (config.PAYME_MERCHANT_ID) rows.push([{ text: "🔵 Payme", callback_data: "pay_payme" }]);
  if (config.CLICK_MERCHANT_ID) rows.push([{ text: "🟢 Click", callback_data: "pay_click" }]);
  rows.push([{ text: "⭐ Telegram Stars", callback_data: "pay_stars" }]);
  return { inline_keyboard: rows };
}

function paymentReviewKeyboard(userId, pid) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Tasdiqlash", callback_data: `payok_${pid}` },
        { text: "❌ Rad etish", callback_data: `payno_${pid}` },
      ],
    ],
  };
}

const adminPanel = {
  inline_keyboard: [
    [{ text: "📊 Statistika", callback_data: "adm_stats" }, { text: "👥 Foydalanuvchilar", callback_data: "adm_users" }],
    [{ text: "💬 Xabarlar", callback_data: "adm_msgs" }, { text: "🧾 To'lovlar", callback_data: "adm_pending" }],
  ],
};

const TASK_PROMPTS = {
  tw: "✍️ Qanday matn yozib berishimni xohlaysiz?\nMasalan: tug'ilgan kunga tabrik yoz, she'r yoz, xat yoz.",
  tt: "🌐 Qaysi matnni qaysi tilga tarjima qilay?\nMasalan: \"Hello world\" — o'zbekchaga tarjima qil.",
  tc: "💻 Qanday kod yozib berishimni xohlaysiz?\nMasalan: Python'da kalkulyator yoz.",
  ts: "📝 Xulosa chiqarish kerak bo'lgan matnni yuboring.",
  tm: "🧮 Masalangizni yozing.\nMasalan: 2x + 5 = 15, x ni top.",
  ti: "💡 Qaysi mavzuda g'oya kerak?\nMasalan: biznes g'oyalar ber.",
  te: "📖 Nimani tushuntirib berishimni xohlaysiz?\nMasalan: sun'iy intellekt nima?",
  essay: "🎓 Insho yoki referat mavzusini yozing.\nMasalan: \"Vatanim — faxrim\" mavzusida insho yoz.",
};

module.exports = {
  mainMenu,
  subscribeKeyboard,
  aiSelectKeyboard,
  tasksKeyboard,
  premiumKeyboard,
  paymentReviewKeyboard,
  adminPanel,
  TASK_PROMPTS,
};
