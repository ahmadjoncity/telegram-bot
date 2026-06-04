# 🤖 Ustoz AKA AI — Telegram bot

Ko'p funksiyali o'zbekcha Telegram AI bot: AI chat, **rasm yaratish**, **rasm tahlili (vision)**,
**ovozni matnga aylantirish**, **chek bilan to'lov**, referal tizimi va kuchli admin panel.

## ✨ Imkoniyatlar

- 🤖 **AI chat** — Groq (Llama 3.3 70B / 8B) va Cohere. Bittasi ishlamasa, avtomatik zaxiraga o'tadi.
- 🎨 **Rasm yaratish** — matndan rasm (Pollinations). Prompt avtomatik inglizchaga o'giriladi.
- 🖼 **Rasm tahlili** — yuborilgan rasmni AI tushuntiradi (vision).
- 🎤 **Ovozli xabar** — ovoz matnga aylanadi (Whisper) va javob beriladi.
- 💳 **To'lov + CHEK** — karta orqali to'lab, chek (skrinshot) yuboriladi; admin tasdiqlaydi/rad etadi.
- 👥 **Referal** — do'st taklif qilgan uchun bepul kunlar.
- 📊 **Hisob** — status, qolgan kunlar, xabar/rasm soni, takliflar.
- 🛠 **Admin panel** — statistika, foydalanuvchilar, to'lovlar, broadcast va boshqalar.

## 🚀 O'rnatish

```bash
npm install
cp .env.example .env   # va qiymatlarni to'ldiring
npm start
```

## 🔑 Sozlamalar (.env)

| O'zgaruvchi | Tavsif |
|---|---|
| `TELEGRAM_TOKEN` | @BotFather dan olinadi (majburiy) |
| `ADMIN_ID` | Sizning Telegram ID (@userinfobot) |
| `GROQ_API_KEY` | https://console.groq.com — chat/vision/ovoz uchun (bepul) |
| `COHERE_API_KEY` | https://dashboard.cohere.com — ixtiyoriy qo'shimcha model |
| `POLLINATIONS_TOKEN` | https://enter.pollinations.ai — ishonchli rasm uchun (bepul) |
| `REQUIRED_CHANNEL` / `CHANNEL_URL` / `INSTAGRAM_URL` | Majburiy obuna |
| `CARD_NUMBER` / `CARD_HOLDER` | Karta orqali to'lov uchun |
| `PREMIUM_SOM` / `PREMIUM_MONTHS` / `STARS_PRICE` | Tarif |
| `FREE_DAYS` / `FREE_IMAGE_PER_DAY` / `REFERRAL_BONUS_DAYS` | Limitlar |
| `PAYME_MERCHANT_ID` / `CLICK_MERCHANT_ID` | Ixtiyoriy to'lov tizimlari |

> **Rasm haqida:** `POLLINATIONS_TOKEN` siz ham ishlaydi, lekin Pollinations bepul (kalitsiz)
> rejimida limit qattiq bo'lib qolgan. Ishonchli rasm uchun bepul kalitni qo'shing.

## 💳 To'lov (chek) jarayoni

1. Foydalanuvchi **💎 Premium → 💳 Karta orqali** tugmasini bosadi.
2. Bot karta raqami va summani ko'rsatadi.
3. Foydalanuvchi to'lab, **chek rasmini** yuboradi.
4. Chek adminga **✅ Tasdiqlash / ❌ Rad etish** tugmalari bilan boradi.
5. Admin tasdiqlasa — Premium avtomatik faollashadi.

## 🛠 Admin buyruqlari

`/admin` `/stats` `/users` `/messages` `/pending` `/find <so'rov>`
`/givepremium <id> [oy]` `/revoke <id>` `/adddays <id> <kun>` `/ban <id>` `/unban <id>`
`/broadcast <matn>` — hammaga xabar. Rasm/video uchun: rasmni `/sendphoto matn` izohi bilan yuboring.

## 📁 Tuzilma

```
index.js          # asosiy bot mantiqi va handlerlar
src/config.js     # sozlamalar va konstantalar
src/db.js         # JSON ma'lumotlar bazasi
src/ai.js         # AI (chat, rasm, vision, ovoz)
src/keyboards.js  # menyular va tugmalar
```
