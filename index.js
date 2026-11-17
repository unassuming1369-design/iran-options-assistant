const express = require("express");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;

const TSETMC =
  "https://cdn.tsetmc.com/api/Instrument/GetInstrumentOptionMarketWatch/1";

let cache = null;
let cacheTime = 0;

function findRecords(data) {
  if (!data || typeof data !== "object") return null;

  if (Array.isArray(data.records)) return data.records;

  if (Array.isArray(data)) {
    if (data.length && typeof data[0] === "object") return data;
    for (const item of data) {
      const found = findRecords(item);
      if (found) return found;
    }
  }

  for (const value of Object.values(data)) {
    const found = findRecords(value);
    if (found) return found;
  }

  return null;
}

async function getOptions() {
  if (cache && Date.now() - cacheTime < 30000) {
    return cache;
  }

  const response = await fetch(TSETMC, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error("TSETMC HTTP " + response.status);
  }

  const raw = await response.text();

  if (
    raw.includes("دسترسی شما") ||
    raw.includes("General Error Detected")
  ) {
    throw new Error("TSETMC access blocked");
  }

  const data = JSON.parse(raw);
  const records = findRecords(data);

  if (!records) {
    throw new Error("Unknown TSETMC response structure");
  }

  const result = {
    count: records.length,
    fields:
      records.length && typeof records[0] === "object"
        ? Object.keys(records[0])
        : [],
    updatedAt: new Date().toISOString()
  };

  cache = result;
  cacheTime = Date.now();

  return result;
}

async function sendTelegram(chatId, message) {
  if (!TOKEN) return;

  const response = await fetch(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  if (!response.ok) {
    console.error("Telegram send failed:", response.status);
  }
}

app.get("/", (req, res) => {
  res.send("Iran Options Assistant is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    uptime: Math.floor(process.uptime()),
    version: "2.0"
  });
});

app.post("/telegram", async (req, res) => {
  if (
    !SECRET ||
    req.headers["x-telegram-bot-api-secret-token"] !== SECRET
  ) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const message = req.body?.message;
  if (!message?.text || !message?.chat?.id) return;

  const chatId = message.chat.id;
  const command = message.text
    .trim()
    .split(/\s+/)[0]
    .split("@")[0];

  let reply = "";

  if (command === "/start") {
    reply =
      "دستیار اختیار معامله ایران\n\n" +
      "نسخه ۲ فعال شد.\n" +
      "برای راهنما /help را بفرست.";
  }

  else if (command === "/help") {
    reply =
      "دستورات دستیار:\n\n" +
      "/start - شروع\n" +
      "/help - راهنما\n" +
      "/status - وضعیت ربات\n" +
      "/market - دریافت وضعیت داده اختیار\n\n" +
      "سیگنال‌دهی هنوز فعال نشده است.";
  }

  else if (command === "/status") {
    reply =
      "وضعیت سرور: فعال\n" +
      "نسخه: 2.0\n" +
      "منبع داده: TSETMC\n" +
      "تحلیل و سیگنال: در حال توسعه";
  }

  else if (command === "/market") {
    reply = "در حال بررسی داده‌های اختیار معامله...";

    await sendTelegram(chatId, reply);

    try {
      const result = await getOptions();

      reply =
        "گزارش دریافت داده اختیار معامله\n\n" +
        "تعداد رکوردهای دریافتی: " + result.count + "\n\n" +
        "فیلدهای خام دریافتی:\n" +
        (result.fields.join(", ") || "فعلاً فیلدی شناسایی نشد") +
        "\n\n" +
        "زمان دریافت: " + result.updatedAt +
        "\n\n" +
        "این گزارش هنوز تحلیل یا سیگنال معاملاتی نیست.";

    } catch (error) {
      console.error("Market data error:", error.message);

      reply =
        "دریافت داده بازار ناموفق بود.\n\n" +
        "علت: " + error.message +
        "\n\n" +
        "تا زمان تأیید داده معتبر، هیچ سیگنالی صادر نمی‌شود.";
    }

  }

  else {
    reply = "دستور نامعتبر است. برای راهنما /help را بفرست.";
  }

  if (reply) {
    await sendTelegram(chatId, reply);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Iran Options Assistant v2 running on " + PORT);
});
