import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import https from "https";
import dotenv from "dotenv";

dotenv.config();

const agent = new https.Agent({ rejectUnauthorized: false });
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// user state
const state = {}; // { chatId: { meters: [{name, accountNo}], step, temp, autoBalanceInterval } }

// reset chat state
function reset(chatId) {
  if (!state[chatId]) state[chatId] = {};
  if (!state[chatId].meters) state[chatId].meters = [];
  state[chatId].step = "idle";
  state[chatId].temp = {};
}

// parse interval
function parseInterval(value) {
  switch (value) {
    case "6h": return 6 * 60 * 60 * 1000;
    case "12h": return 12 * 60 * 60 * 1000;
    case "1d": return 24 * 60 * 60 * 1000;
    case "2d": return 2 * 24 * 60 * 60 * 1000;
    case "none": return null;
    default: return null;
  }
}

// helper: send message with /start button
function sendReplyWithStart(chatId, text, keyboard=[]) {
  const finalKeyboard = [...keyboard, [{ text: "🏠 /start", callback_data: "start" }]];
  return bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: finalKeyboard }
  });
}

// ---------------------- Start ----------------------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  reset(chatId);

  bot.sendMessage(chatId, "Welcome! Select an option:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Set Meter", callback_data: "set_meter" }],
        [{ text: "Get Balance", callback_data: "get_balance" }],
        [{ text: "Settings", callback_data: "settings" }]
      ]
    }
  });
});

// ---------------------- Button click handler ----------------------
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (!state[chatId]) reset(chatId);

  // handle /start button
  if (data === "start") return bot.emit("text", { chat: { id: chatId }, text: "/start" });

  // ---------------- Set Meter ----------------
  if (data === "set_meter") {
    state[chatId].step = "await_meter_name";
    return sendReplyWithStart(chatId, "Enter a **unique name** for your meter:");
  }

  // ---------------- Get Balance ----------------
  if (data === "get_balance") {
    if (!state[chatId].meters || state[chatId].meters.length === 0)
      return sendReplyWithStart(chatId, "🚫 No meters found. First set a meter.");

    let replyText = "⏳ Fetching balances...\n\n";
    for (const meter of state[chatId].meters) {
      try {
        const url = `https://prepaid.desco.org.bd/api/unified/customer/getBalance?accountNo=${meter.accountNo}`;
        const res = await fetch(url, { agent });
        const apiData = await res.json();
        if (apiData.code === 200 && apiData.data?.balance !== undefined) {
          replyText += `${meter.name} -> ${apiData.data.balance}৳\n`;
        } else replyText += `${meter.name} -> ❌ Not found\n`;
      } catch (err) {
        console.error(err);
        replyText += `${meter.name} -> ⚠️ API error\n`;
      }
    }
    return sendReplyWithStart(chatId, replyText.trim());
  }

  // ---------------- Settings ----------------
  if (data === "settings") {
    if (!state[chatId].meters || state[chatId].meters.length === 0)
      return sendReplyWithStart(chatId, "🚫 No meters found. First set a meter.");

    const keyboard = state[chatId].meters.flatMap(m => [
      [{ text: `✏️ ${m.name}`, callback_data: `edit_${m.name}` }],
      [{ text: `🗑 Delete ${m.name}`, callback_data: `delete_${m.name}` }],
      [{ text: `ℹ️ Info ${m.name}`, callback_data: `info_${m.name}` }]
    ]);
    keyboard.push([{ text: "Auto Balance Interval", callback_data: "auto_balance" }]);
    return sendReplyWithStart(chatId, "Settings Menu:", keyboard);
  }

  // ---------------- Meter Info ----------------
  if (data.startsWith("info_")) {
    const meterName = data.slice(5);
    const meter = state[chatId].meters.find(m => m.name === meterName);
    if (!meter) return sendReplyWithStart(chatId, `❌ Meter not found: ${meterName}`);

    try {
      const url = `https://prepaid.desco.org.bd/api/unified/customer/getCustomerInfo?accountNo=${meter.accountNo}`;
      const res = await fetch(url, { agent });
      const apiData = await res.json();
      if (apiData.code === 200 && apiData.data) {
        const info = apiData.data;
        const msgText =
          `ℹ️ Meter Info: ${meterName}\n\n` +
          `Account No: ${info.accountNo}\nCustomer: ${info.customerName}\nContact: ${info.contactNo}\nMeter No: ${info.meterNo}\nAddress: ${info.installationAddress}\nFeeder: ${info.feederName}\nInstallation Date: ${info.installationDate}\nPhase: ${info.phaseType}\nSanction Load: ${info.sanctionLoad}\nTariff: ${info.tariffSolution}\nMeter Model: ${info.meterModel}\nTransformer: ${info.transformer}\nSD Name: ${info.SDName}`;
        return sendReplyWithStart(chatId, msgText);
      } else return sendReplyWithStart(chatId, `❌ Info not found for meter: ${meterName}`);
    } catch (err) {
      console.error(err);
      return sendReplyWithStart(chatId, `⚠️ API error for meter: ${meterName}`);
    }
  }

  // ---------------- Edit meter name ----------------
  if (data.startsWith("edit_")) {
    const meterName = data.slice(5);
    state[chatId].temp.editMeterName = meterName;
    state[chatId].step = "await_new_meter_name";
    return sendReplyWithStart(chatId, `Enter a new name for meter "${meterName}":`);
  }

  // ---------------- Delete meter ----------------
  if (data.startsWith("delete_")) {
    const meterName = data.slice(7);
    const index = state[chatId].meters.findIndex(m => m.name === meterName);
    if (index !== -1) {
      state[chatId].meters.splice(index, 1);
      return sendReplyWithStart(chatId, `🗑 Meter deleted: ${meterName}`);
    } else return sendReplyWithStart(chatId, `❌ Meter not found: ${meterName}`);
  }

  // ---------------- Auto Balance ----------------
  if (data === "auto_balance") {
    state[chatId].step = "await_auto_interval";
    return sendReplyWithStart(chatId, "Choose auto balance interval:", [
      [{ text: "6 Hours", callback_data: "6h" }],
      [{ text: "12 Hours", callback_data: "12h" }],
      [{ text: "1 Day", callback_data: "1d" }],
      [{ text: "2 Days", callback_data: "2d" }],
      [{ text: "Not Auto", callback_data: "none" }]
    ]);
  }

  // ---------------- Auto Balance interval selection ----------------
  if (state[chatId].step === "await_auto_interval" && ["6h","12h","1d","2d","none"].includes(data)) {
    if (state[chatId].autoBalanceInterval) clearInterval(state[chatId].autoBalanceInterval);
    const intervalMs = parseInterval(data);

    if (intervalMs) {
      state[chatId].autoBalanceInterval = setInterval(async () => {
        if (!state[chatId].meters || state[chatId].meters.length === 0) return;
        let reply = "";
        for (const meter of state[chatId].meters) {
          try {
            const url = `https://prepaid.desco.org.bd/api/unified/customer/getBalance?accountNo=${meter.accountNo}`;
            const res = await fetch(url, { agent });
            const apiData = await res.json();
            if (apiData.code === 200 && apiData.data?.balance !== undefined)
              reply += `${meter.name} -> ${apiData.data.balance}৳\n`;
            else reply += `${meter.name} -> ❌ Not found\n`;
          } catch (err) {
            console.error(err);
            reply += `${meter.name} -> ⚠️ API error\n`;
          }
        }
        if (reply) bot.sendMessage(chatId, reply.trim());
      }, intervalMs);
    }

    state[chatId].step = "idle";
    return sendReplyWithStart(chatId, `✅ Auto balance interval set: ${data}`);
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// ---------------------- Meter input handler ----------------------
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!state[chatId]) reset(chatId);

  // Add meter unique name
  if (state[chatId].step === "await_meter_name") {
    if (state[chatId].meters.find(m => m.name === text))
      return sendReplyWithStart(chatId, "❌ Name already used, choose another.");
    state[chatId].temp.name = text;
    state[chatId].step = "await_meter_account";
    return sendReplyWithStart(chatId, "Enter meter account number:");
  }

  // Add meter account number
  if (state[chatId].step === "await_meter_account") {
    const accountNo = text;
    const name = state[chatId].temp.name;
    state[chatId].meters.push({ name, accountNo });
    state[chatId].step = "idle";
    state[chatId].temp = {};
    return sendReplyWithStart(chatId, `✅ Meter added: ${name} (${accountNo})`);
  }

  // Update meter name
  if (state[chatId].step === "await_new_meter_name") {
    const newName = text;
    if (state[chatId].meters.find(m => m.name === newName))
      return sendReplyWithStart(chatId, "❌ Name already exists. Choose another.");
    const oldName = state[chatId].temp.editMeterName;
    const meter = state[chatId].meters.find(m => m.name === oldName);
    if (meter) meter.name = newName;
    state[chatId].step = "idle";
    state[chatId].temp = {};
    return sendReplyWithStart(chatId, `✅ Meter name updated: ${oldName} → ${newName}`);
  }
});
