// ============================================================
//  config.js — barcha sozlamalar va konstantalar
// ============================================================
require("dotenv").config();

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

const config = {
  // --- Telegram ---
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  ADMIN_ID: int(process.env.ADMIN_ID, 0),

  // --- AI providerlar ---
  GROQ_KEY: process.env.GROQ_API_KEY || "",
  COHERE_KEY: process.env.COHERE_API_KEY || "",

  // --- Obuna talab qilinadigan ijtimoiy tarmoqlar ---
  CHANNEL: process.env.REQUIRED_CHANNEL || "@ustozaka_ai",
  CHANNEL_URL: process.env.CHANNEL_URL || "https://t.me/ustozaka_ai",
  INSTAGRAM_URL: process.env.INSTAGRAM_URL || "https://instagram.com/ustozainews",

  // --- Tarif / limitlar ---
  FREE_DAYS: int(process.env.FREE_DAYS, 20),
  PREMIUM_SOM: int(process.env.PREMIUM_SOM, 15000),
  STARS: int(process.env.STARS_PRICE, 50),
  PREMIUM_MONTHS: int(process.env.PREMIUM_MONTHS, 1),
  FREE_IMAGE_PER_DAY: int(process.env.FREE_IMAGE_PER_DAY, 5),
  REFERRAL_BONUS_DAYS: int(process.env.REFERRAL_BONUS_DAYS, 7),

  // --- To'lov (karta orqali, chek bilan) ---
  CARD_NUMBER: process.env.CARD_NUMBER || "8600 1234 5678 9012",
  CARD_HOLDER: process.env.CARD_HOLDER || "USTOZ AKA",
  PAYME_MERCHANT_ID: process.env.PAYME_MERCHANT_ID || "",
  CLICK_MERCHANT_ID: process.env.CLICK_MERCHANT_ID || "",

  // --- Rasm generatsiya (Pollinations) ---
  // Ishonchli rasm uchun bepul kalit oling: https://enter.pollinations.ai
  POLLINATIONS_TOKEN: process.env.POLLINATIONS_TOKEN || "",
  IMAGE_MODEL: process.env.IMAGE_MODEL || "flux",
  IMAGE_WIDTH: int(process.env.IMAGE_WIDTH, 1024),
  IMAGE_HEIGHT: int(process.env.IMAGE_HEIGHT, 1024),

  // --- AI modellar ---
  MODELS: {
    // matnli (chat) modellar
    chat: {
      groq: { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (kuchli)" },
      fast: { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (tezkor)" },
    },
    vision: "meta-llama/llama-4-scout-17b-16e-instruct",
    whisper: "whisper-large-v3-turbo",
    cohere: "command-a-03-2025",
    cohereFallback: "command-r-plus",
  },

  // --- Boshqa ---
  DB_FILE: process.env.DB_FILE || "db.json",
  HISTORY_LIMIT: 20, // suhbatda saqlanadigan oxirgi xabarlar soni
  MAX_MSG_LEN: 4000, // Telegram bitta xabar uchun limit

  SYSTEM_PROMPT:
    "Sen 'Ustoz AKA AI' nomli foydali, samimiy va aqlli yordamchisan. " +
    "Foydalanuvchiga uning tilida (asosan o'zbek tilida) qisqa, aniq va tushunarli javob ber. " +
    "Kerak bo'lsa kod, misol va bosqichma-bosqich tushuntirish ber. Hurmatli va do'stona bo'l.",
};

module.exports = config;
