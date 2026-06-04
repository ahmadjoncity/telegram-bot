// ============================================================
//  db.js — JSON asosidagi oddiy ma'lumotlar bazasi
// ============================================================
const fs = require("fs");
const path = require("path");
const config = require("./config");

const DB_PATH = path.resolve(process.cwd(), config.DB_FILE);

const DEFAULT_DB = { users: {}, msgs: [], payments: [], stats: { images: 0, messages: 0 } };

// Yozishlarni ketma-ket qilish uchun (race condition oldini olish)
let writeQueue = Promise.resolve();

function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    // Eski bazalarni yangi sxema bilan to'ldirish
    if (!data.users) data.users = {};
    if (!data.msgs) data.msgs = [];
    if (!data.payments) data.payments = [];
    if (!data.stats) data.stats = { images: 0, messages: 0 };
    return data;
  } catch (e) {
    console.error("[db] o'qishda xato, bo'sh baza ishlatiladi:", e.message);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB(db) {
  // Atomik yozish: avval vaqtinchalik faylga, keyin rename
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function newUser(id) {
  return {
    id,
    name: "",
    username: "",
    count: 0,
    imageCount: 0,
    premium: false,
    premiumUntil: null,
    joined: new Date().toISOString(),
    model: "groq",
    bonusDays: 0,
    referredBy: null,
    referrals: [],
    banned: false,
    imageDay: "",
    imageDayCount: 0,
    lastMsg: null,
  };
}

function getUser(id) {
  const db = loadDB();
  if (!db.users[id]) {
    db.users[id] = newUser(id);
    saveDB(db);
  } else {
    // eski foydalanuvchilarda yangi maydonlar yo'q bo'lsa to'ldiramiz
    db.users[id] = Object.assign(newUser(id), db.users[id]);
  }
  return db.users[id];
}

function setUser(id, data) {
  const db = loadDB();
  const base = db.users[id] || newUser(id);
  db.users[id] = Object.assign(base, data);
  saveDB(db);
  return db.users[id];
}

function allUsers() {
  return Object.values(loadDB().users);
}

function addMsg(entry) {
  const db = loadDB();
  db.msgs.push({
    id: entry.id,
    name: (entry.name || "").slice(0, 40),
    uname: entry.uname || "",
    text: (entry.text || "").slice(0, 200),
    model: entry.model || "-",
    t: new Date().toISOString(),
  });
  if (db.msgs.length > 2000) db.msgs = db.msgs.slice(-2000);
  db.stats.messages = (db.stats.messages || 0) + 1;
  saveDB(db);
}

function incImageStat() {
  const db = loadDB();
  db.stats.images = (db.stats.images || 0) + 1;
  saveDB(db);
}

// ---- To'lovlar ----
function addPayment(payment) {
  const db = loadDB();
  const id = "p" + Date.now() + Math.floor(Math.random() * 1000);
  const record = Object.assign({ pid: id, status: "pending", t: new Date().toISOString() }, payment);
  db.payments.push(record);
  if (db.payments.length > 1000) db.payments = db.payments.slice(-1000);
  saveDB(db);
  return record;
}

function getPayment(pid) {
  return loadDB().payments.find((p) => p.pid === pid) || null;
}

function setPaymentStatus(pid, status) {
  const db = loadDB();
  const p = db.payments.find((x) => x.pid === pid);
  if (p) {
    p.status = status;
    p.handledAt = new Date().toISOString();
    saveDB(db);
  }
  return p;
}

function pendingPayments() {
  return loadDB().payments.filter((p) => p.status === "pending");
}

module.exports = {
  loadDB,
  saveDB,
  getUser,
  setUser,
  allUsers,
  addMsg,
  incImageStat,
  addPayment,
  getPayment,
  setPaymentStatus,
  pendingPayments,
};
