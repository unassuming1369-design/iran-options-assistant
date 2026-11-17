const express = require("express");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;

app.get("/", (req, res) => {
  res.send("Iran Options Assistant is running");
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
  if (!message?.text || !message?.chat?.id || !TOKEN) return;

  const chatId = message.chat.id;
  const command = message.text.trim().split(" ")[0];

  let reply = "دستیار اختیار معامله ایران\n\n";

  if (command === "/start") {
    reply +=
      "ربات با موفقیت راه‌اندازی شده است.\n\n" +
      "برای مشاهده امکانات، /help را بفرست.";
  } else if (command === "/help") {
    reply +=
      "/start - شروع ربات\n" +
      "/help - راهنما\n" +
      "/status - وضعیت سامانه\n\n" +
      "موتور تحلیل و دریافت داده بازار هنوز فعال نشده است.";
  } else if (command === "/status") {
    reply +=
      "ارتباط ربات برقرار است.\n" +
      "اتصال داده‌های بازار: در انتظار راه‌اندازی";
  } else {
    reply += "برای راهنما دستور /help را بفرست.";
  }

  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });
  } catch (error) {
    console.error("Telegram error:", error.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
