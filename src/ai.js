// ============================================================
//  ai.js — AI provayderlar bilan ishlash (chat, rasm, ko'rish, ovoz)
// ============================================================
const fs = require("fs");
const Groq = require("groq-sdk");
const { CohereClient } = require("cohere-ai");
const config = require("./config");

const groq = config.GROQ_KEY ? new Groq({ apiKey: config.GROQ_KEY }) : null;
const cohere = config.COHERE_KEY ? new CohereClient({ token: config.COHERE_KEY }) : null;

// ------------------------------------------------------------
//  Matnli chat — tanlangan model + avtomatik zaxira (fallback)
// ------------------------------------------------------------
async function chat({ model, text, history }) {
  const provider = model === "cohere" ? "cohere" : "groq";

  // 1-urinish: tanlangan provayder
  try {
    if (provider === "cohere") return await chatCohere(text, history);
    const modelId = model === "fast" ? config.MODELS.chat.fast.id : config.MODELS.chat.groq.id;
    return await chatGroq(text, history, modelId);
  } catch (e) {
    console.error(`[ai] ${provider} xato:`, e.message);
    // 2-urinish: zaxira provayder
    try {
      if (provider === "cohere" && groq) return await chatGroq(text, history, config.MODELS.chat.fast.id);
      if (provider !== "cohere" && cohere) return await chatCohere(text, history);
    } catch (e2) {
      console.error("[ai] zaxira ham xato:", e2.message);
    }
    throw e;
  }
}

async function chatGroq(text, history, modelId) {
  if (!groq) throw new Error("GROQ_API_KEY yo'q");
  const messages = [
    { role: "system", content: config.SYSTEM_PROMPT },
    ...history,
    { role: "user", content: text },
  ];
  const res = await groq.chat.completions.create({
    model: modelId,
    messages,
    max_tokens: 1500,
    temperature: 0.7,
  });
  return (res.choices[0].message.content || "").trim();
}

async function chatCohere(text, history) {
  if (!cohere) throw new Error("COHERE_API_KEY yo'q");
  const chatHistory = history.map((h) => ({
    role: h.role === "user" ? "USER" : "CHATBOT",
    message: h.content,
  }));
  let res;
  try {
    res = await cohere.chat({
      model: config.MODELS.cohere,
      message: text,
      chatHistory,
      preamble: config.SYSTEM_PROMPT,
    });
  } catch (e) {
    res = await cohere.chat({
      model: config.MODELS.cohereFallback,
      message: text,
      chatHistory,
      preamble: config.SYSTEM_PROMPT,
    });
  }
  return (res.text || "").trim();
}

// ------------------------------------------------------------
//  Rasm uchun matnni ingliz tiliga aylantirib, sifatli prompt yasash
// ------------------------------------------------------------
async function enhanceImagePrompt(userText) {
  try {
    if (!groq) return userText;
    const res = await groq.chat.completions.create({
      model: config.MODELS.chat.fast.id,
      messages: [
        {
          role: "system",
          content:
            "You convert any user request into a single, vivid English image-generation prompt. " +
            "Output ONLY the prompt text, no quotes, no explanations, max 60 words. Add style and detail keywords.",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 150,
      temperature: 0.8,
    });
    const out = (res.choices[0].message.content || "").trim();
    return out || userText;
  } catch (e) {
    console.error("[ai] prompt enhance xato:", e.message);
    return userText;
  }
}

// ------------------------------------------------------------
//  Rasm generatsiya — Pollinations.ai
//  Kalit (POLLINATIONS_TOKEN) bo'lsa: gen.pollinations.ai (ishonchli).
//  Kalitsiz: eski image.pollinations.ai endpoint (limitli, retry bilan).
// ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildImageUrl(enhanced, seed, width, height) {
  const model = config.IMAGE_MODEL || "flux";
  if (config.POLLINATIONS_TOKEN) {
    return (
      "https://gen.pollinations.ai/image/" +
      encodeURIComponent(enhanced) +
      `?model=${encodeURIComponent(model)}&width=${width}&height=${height}&seed=${seed}&nologo=true`
    );
  }
  return (
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(enhanced) +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=${encodeURIComponent(model)}`
  );
}

async function generateImage(prompt, opts = {}) {
  const enhanced = await enhanceImagePrompt(prompt);
  const width = opts.width || config.IMAGE_WIDTH;
  const height = opts.height || config.IMAGE_HEIGHT;
  const headers = config.POLLINATIONS_TOKEN
    ? { Authorization: "Bearer " + config.POLLINATIONS_TOKEN }
    : {};

  const maxAttempts = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const seed = Math.floor(Math.random() * 1e9);
    const url = buildImageUrl(enhanced, seed, width, height);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      const ct = resp.headers.get("content-type") || "";
      if (resp.ok && ct.startsWith("image")) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length < 1000) throw new Error("Bo'sh rasm qaytdi");
        return { buffer, prompt: enhanced };
      }
      // 402/429 = navbat to'la / limit — biroz kutib qayta urinamiz
      lastErr = "status " + resp.status;
      if (resp.status === 402 || resp.status === 429) {
        if (attempt < maxAttempts) { await sleep(2500 * attempt); continue; }
      }
      throw new Error("Pollinations " + lastErr);
    } catch (e) {
      lastErr = e.message;
      if (attempt < maxAttempts && /abort|network|fetch|ECONN/i.test(e.message)) {
        await sleep(1500 * attempt);
        continue;
      }
      if (attempt >= maxAttempts) throw new Error("Rasm yaratib bo'lmadi: " + lastErr);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Rasm yaratib bo'lmadi: " + lastErr);
}

// ------------------------------------------------------------
//  Ko'rish (Vision) — rasmni tahlil qilish
// ------------------------------------------------------------
async function analyzeImage(imageUrl, question) {
  if (!groq) throw new Error("GROQ_API_KEY yo'q");
  const res = await groq.chat.completions.create({
    model: config.MODELS.vision,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question || "Bu rasmda nima borligini o'zbek tilida batafsil tushuntir." },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 1200,
    temperature: 0.5,
  });
  return (res.choices[0].message.content || "").trim();
}

// ------------------------------------------------------------
//  Ovozni matnga aylantirish (Whisper)
// ------------------------------------------------------------
async function transcribe(filePath) {
  if (!groq) throw new Error("GROQ_API_KEY yo'q");
  const res = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: config.MODELS.whisper,
  });
  return (res.text || "").trim();
}

module.exports = {
  chat,
  generateImage,
  enhanceImagePrompt,
  analyzeImage,
  transcribe,
  hasGroq: !!groq,
  hasCohere: !!cohere,
};
