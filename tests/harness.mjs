// Test harness: runs the real Worker against a real SQLite database (shaped like
// Cloudflare D1) and a fake Telegram API that records every call.
import { DatabaseSync } from "node:sqlite";

export async function createHarness() {
  // Fresh copy of the worker module for every harness, so module state doesn't leak.
  const worker = (await import(`../src/index.js?case=${Math.random()}`)).default;
  const db = new DatabaseSync(":memory:");
  const stmt = (sql) => ({
    args: [],
    bind(...a) { this.args = a; return this; },
    async run() { db.prepare(sql).run(...this.args); return {}; },
    async first() { return db.prepare(sql).get(...this.args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...this.args) }; },
  });
  const DB = { prepare: stmt, async batch(list) { for (const s of list) await s.run(); } };
  const env = { BOT_TOKEN: "123:test-token", DB };

  const h = {
    worker, db, env,
    calls: [], // every Telegram API call: { method, ...body, ok }
    failChats: new Set(), // sendMessage to these chats fails with 403
    openDMs: new Set(), // users who pressed Start in a private chat
    botStatus: { status: "administrator", can_delete_messages: true },
    now: Date.UTC(2026, 10, 25, 3, 0), // Wed 25 Nov 2026, 08:00 in Tashkent
    nextMessageId: 1000,
    nextIncomingId: 1,
  };
  Date.now = () => h.now;

  globalThis.fetch = async (url, opts) => {
    const method = url.split("/").pop();
    const body = JSON.parse(opts.body);
    let ok = true, result = true, error_code;
    if (method === "getChatMember") result = body.user_id === 123 ? h.botStatus : { status: "member" };
    if (method === "getMe") result = { username: "TestDutyBot" };
    if (method === "sendMessage") {
      const isDM = body.chat_id > 0;
      if (h.failChats.has(body.chat_id) || (isDM && !h.openDMs.has(body.chat_id))) { ok = false; error_code = 403; }
      else result = { message_id: h.nextMessageId++ };
    }
    h.calls.push({ method, ...body, ok });
    return { json: async () => ({ ok, result, error_code }) };
  };

  const secret = async () => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.BOT_TOKEN));
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  };

  /** Send a Telegram update to the webhook; returns the Telegram calls it caused. */
  h.update = async (update) => {
    const n = h.calls.length;
    await worker.fetch(new Request("https://bot.test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": await secret() },
      body: JSON.stringify(update),
    }), env);
    return h.calls.slice(n);
  };

  /** A user types text in a group (chatId < 0) or in a private chat (chatId omitted). */
  h.say = async (user, text, chatId) => {
    const chat = chatId ? { id: chatId, type: "supergroup", title: `Group ${chatId}` } : { id: user.id, type: "private" };
    const out = await h.update({ message: { message_id: h.nextIncomingId++, text, from: user, chat } });
    return out.filter((c) => c.method === "sendMessage");
  };

  /** The bot is added to (or removed from) a group by `user`. */
  h.membership = (user, chatId, newStatus = "member", oldStatus = "left") =>
    h.update({ my_chat_member: {
      chat: { id: chatId, type: "supergroup", title: `Group ${chatId}` }, from: user,
      old_chat_member: { status: oldStatus }, new_chat_member: { status: newStatus },
    } });

  /** A control-center button press. */
  h.press = (user, data) =>
    h.update({ callback_query: { id: `cb${h.nextIncomingId++}`, from: user, data,
      message: { message_id: 1, chat: { id: user.id, type: "private" } } } });

  /** Run the every-minute cron once. */
  h.tick = async () => {
    const n = h.calls.length;
    let pending;
    await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } });
    await pending;
    return h.calls.slice(n);
  };

  /** Run the cron minute by minute until `untilUtcMs`; returns reminders sent. */
  h.runUntil = async (untilUtcMs) => {
    const reminders = [];
    while (h.now < untilUtcMs) {
      for (const c of await h.tick()) {
        const who = c.method === "sendMessage" && c.text.match(/duty person is @(\S+)/)?.[1];
        if (who) reminders.push({ at: new Date(h.now).toISOString(), chat: c.chat_id, who });
      }
      h.now += 60_000;
    }
    return reminders;
  };

  h.init = async () => (await worker.fetch(new Request("https://bot.test/init"), env)).text();
  h.group = (chatId) => {
    const row = db.prepare("SELECT v FROM store WHERE k = ?").get(`chat:${chatId}`);
    return row ? JSON.parse(row.v) : null;
  };

  return h;
}

export const user = (id, username) => ({ id, username, first_name: username });
