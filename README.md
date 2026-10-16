# NeuroPay Backend (Render-Ready)

بک‌اند NeuroPay با Node.js + TypeScript + Express + PostgreSQL، آماده استقرار رایگان روی Render.com.

## 📁 ساختار پروژه

```
neuropay-backend/
├── package.json        # وابستگی‌ها و اسکریپت‌ها
├── tsconfig.json       # تنظیمات TypeScript
├── render.yaml         # Blueprint یک‌کلیکی Render
├── schema.sql          # اسکیمای کامل دیتابیس + داده نمونه
└── src/
    └── index.ts        # سرور کامل Express
```

## 🔌 اندپوینت‌ها

| متد | مسیر | توضیح |
|-----|------|-------|
| GET | `/` | چک سلامت سرویس |
| POST | `/api/wallet/topup-offline` | شارژ کیف پول به‌صورت آفلاین |
| POST | `/api/transactions/batch-sync` | همگام‌سازی دسته‌ای تراکنش‌های آفلاین اپ راننده (با nonce و ضد دو-خرج) |
| GET | `/api/transactions/recent?limit=20` | لیست تراکنش‌های اخیر داشبورد |
| GET | `/api/driver/:driverCode/balance` | بررسی سریع موجودی راننده |

## 🚀 راهنمای گام‌به‌گام استقرار رایگان روی Render.com

### مرحله ۱: ساخت پروژه لوکال (روی سیستم خودتان)
1. یک پوشه جدید بسازید، مثلاً `neuropay-backend`.
2. محتویات فایل ZIP (پوشه‌های `src`، فایل‌های `package.json`، `tsconfig.json`، `schema.sql`، `render.yaml`) را داخل آن کپی کنید.
3. دستور `npm install` را اجرا کنید.
4. (اختیاری) فایل `.env` بسازید:
   ```
   DATABASE_URL=postgresql://user:pass@host:5432/db
   PORT=3000
   ```
5. تست لوکال: `npm run dev` و سپس در مرورگر `http://localhost:3000` را باز کنید. باید `{"status":"ok",...}` ببینید.

### مرحله ۲: آپلود به GitHub
1. وارد حساب GitHub شوید (اگر ندارید در github.com ثبت‌نام کنید).
2. روی علامت **+** بالای صفحه کلیک کنید → **New repository**.
3. نام ریپو: `neuropay-backend` — Public یا Private (هر دو رایگان است) → **Create repository**.
4. در صفحه ریپو روی **uploading an existing file** کلیک کنید.
5. **همه فایل‌ها و پوشه‌ها** (شامل پوشه `src`) را بکشید و رها کنید (Drag & Drop).
6. پیام کامیت بنویسید (مثلاً `Initial NeuroPay backend`) → **Commit changes**.

> ⚠️ اگر کاربر ویندوز هستید و drag&drop پوشه کار نکرد، فایل‌های داخل پوشه `src` را جداگانه آپلود کنید و حتماً مسیر `src/index.ts` حفظ شود.

### مرحله ۳: ساخت دیتابیس رایگان PostgreSQL در Render
1. وارد **dashboard.render.com** شوید (با حساب GitHub لاگین کنید).
2. **New +** → **PostgreSQL** را انتخاب کنید.
3. نام: `neuropay-db` — Region: Frankfurt — Plan: **Free**.
4. روی **Create Database** کلیک کنید و چند دقیقه صبر کنید.
5. بعد از آماده شدن، در بخش **Connections** مقدار **External Database URL** را کپی کنید.

### مرحله ۴: اجرای اسکیمای دیتابیس
ساده‌ترین راه بدون نصب psql:
1. **TablePlus / DBeaver / pgAdmin** را نصب کنید و با External URL به دیتابیس وصل شوید.
2. محتوای فایل `schema.sql` را کامل کپی و اجرا (Run) کنید.
3. باید جدول‌ها ساخته شوند و داده نمونه (راننده‌های `NP-00001` و `NP-00002`) درج شود.

### مرحله ۵: ساخت Web Service (بک‌اند)
1. در داشبورد Render: **New +** → **Web Service**.
2. **Build and deploy from a Git repository** → به GitHub وصل شوید → ریپوی `neuropay-backend` را انتخاب کنید → **Connect**.
3. تنظیمات:
   - **Name:** `neuropay-api`
   - **Region:** Frankfurt
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
4. بخش **Environment Variables** → **Add Environment Variable**:
   - Key: `DATABASE_URL` — Value: همان External Database URL مرحله ۳
5. روی **Create Web Service** کلیک کنید و منتظر بیلد بمانید (چند دقیقه).
6. آدرس سرویس شما چیزی شبیه `https://neuropay-api.onrender.com` خواهد بود.

### مرحله ۶: تست نهایی
در مرورگر یا Postman:

```
GET  https://neuropay-api.onrender.com
→ {"status":"ok","service":"NeuroPay API","version":"1.0.0"}

GET  https://neuropay-api.onrender.com/api/driver/NP-00001/balance
→ موجودی 500000

POST https://neuropay-api.onrender.com/api/wallet/topup-offline
Body (JSON):
{
  "driverCode": "NP-00001",
  "amount": 100000,
  "method": "cash",
  "nonce": "unique-nonce-123"
}

POST https://neuropay-api.onrender.com/api/transactions/batch-sync
Body (JSON):
{
  "driverCode": "NP-00001",
  "transactions": [
    { "localId": "l1", "amount": 25000, "type": "payment", "method": "qr", "nonce": "nonce-abc-1" }
  ]
}

GET  https://neuropay-api.onrender.com/api/transactions/recent?limit=10
```

## 🧠 منطق ضد دو-خرج (Anti Double-Spend)
- هر تراکنش آفلاین باید `nonce` یکتا داشته باشد.
- `nonce`ها در جدول `used_nonces` ثبت می‌شوند؛ تکراری بودن → خطای 409.
- به‌روزرسانی موجودی با `SELECT ... FOR UPDATE` (قفل ردیفی) و داخل تراکنش دیتابیس انجام می‌شود.
- در batch-sync اگر موجودی کافی نباشد، آن آیتم در `rejected` برگردانده می‌شود.

## 💡 نکات مهم Render (پلن رایگان)
- سرویس رایگان بعد از ۱۵ دقیقه بی‌کاری **می‌خوابد**؛ درخواست اول کمی کند می‌شود (Cold Start).
- دیتابیس رایگان Render بعد از ۳۰ روز **حذف می‌شود**؛ برای تست عالی است اما برای پروداکشن دیتابیس پولی یا سرویس دیگر لازم است.
- برای اتصال دائمی، در `.env` یا متغیرهای Render مقدار `DATABASE_URL` را نگه دارید (کد به‌صورت خودکار SSL را فعال می‌کند).

## 🛠 اسکریپت‌ها
```bash
npm install     # نصب وابستگی‌ها
npm run dev     # اجرای محلی (ts-node)
npm run build   # کامپایل به dist/
npm start       # اجرای نسخه build شده (Render همین را اجرا می‌کند)
```
