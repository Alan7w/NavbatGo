/**
 * Daily Duty Bot - Cloudflare Worker version (free hosting).
 *
 * Any Telegram group can add the bot. Each group has its own team,
 * rotation, reminder time, time zone, work days, owner and permissions.
 * The person who adds the bot to a group becomes that group's owner.
 *
 * Needs (set in the Cloudflare dashboard):
 *   - Secret      BOT_TOKEN  -> your token from @BotFather
 *   - D1 binding  DB         -> a D1 database (stores all groups)
 *   - Cron trigger "* * * * *" (every minute; the code decides when to post)
 *
 * After deploying a new version, open https://<your-worker>/init once.
 */

// The group that used the bot before multi-group support keeps this owner.
const LEGACY_OWNER_USERNAME = "asadxonrasulov";

const DEFAULT_TZ = "Asia/Tashkent";
const DEFAULT_TIME = "09:00";
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5]; // 0=Sun, 1=Mon ... 6=Sat
const LAST_CATCHUP_HOUR = 18; // if the reminder was missed, don't post after 18:00
const CLEAN_DELAY_MIN = 2; // clean chat: bot replies disappear after this many minutes

// Cloudflare's free plan allows 50 outside requests per run. Stay well below it;
// anything left over is handled a minute later.
const MAX_REMINDERS_PER_RUN = 25;
const MAX_DELETES_PER_RUN = 20;

// Commands whose permission each group owner can change.
// name: [usage, description, default level]
const COMMAND_INFO = {
  today: ["/today", "who is on duty today", "everyone"],
  schedule: ["/schedule", "who is on duty the next 10 workdays", "everyone"],
  list: ["/list", "the full rotation order", "everyone"],
  skip: ["/skip", "today's person can't do it, pass to the next person", "managers"],
  setturn: ["/setturn @user", "make someone today's duty person", "managers"],
  swap: ["/swap @user1 @user2", "swap two people in the order", "managers"],
  add: ["/add Full Name @username", "add a new person (end of the list)", "managers"],
  remove: ["/remove @username", "remove a person from the team", "managers"],
  away: ["/away @username", "temporarily skip someone (sick, vacation)", "managers"],
  back: ["/back @username", "put them back in the rotation", "managers"],
  pause: ["/pause", "stop daily reminders (holidays)", "managers"],
  resume: ["/resume", "start daily reminders again", "managers"],
  settime: ["/settime HH:MM", "change the reminder time", "managers"],
  settimezone: ["/settimezone Area/City", "change the time zone, e.g. Asia/Tashkent", "owner"],
  setdays: ["/setdays mon-fri", "change the work days, e.g. mon-fri or mon tue wed", "owner"],
};

const LEVELS = ["everyone", "managers", "owner"];
const LEVEL_LABEL = { everyone: "👥 Everyone", managers: "⭐ Managers", owner: "👑 Owner only" };

const DEFAULT_SETTINGS = {
  silent_reminder: true, // daily reminder arrives without sound
  silent_replies: true, // command replies arrive without sound
  clean_chat: true, // delete commands right away, bot replies after a few minutes
};

const SETTING_LABEL = {
  silent_reminder: "🔕 Silent daily reminder",
  silent_replies: "🔕 Silent command replies",
  clean_chat: "🧹 Clean chat",
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ------------------------------------------------------------------ dates --

/** Current date ("2026-11-02") and time in the given time zone. */
function nowLocal(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now()));
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hh: Number(get("hour")) % 24,
    mm: Number(get("minute")),
  };
}

const today = (g) => nowLocal(g.tz).date;

function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekday = (date) => new Date(date + "T00:00:00Z").getUTCDay(); // 0=Sun ... 6=Sat
const isWorkday = (g, date) => g.workdays.includes(weekday(date));

function nextWorkday(g, date) {
  do date = addDays(date, 1); while (!isWorkday(g, date));
  return date;
}

function prettyDate(date) {
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short", day: "2-digit", month: "short", timeZone: "UTC",
  });
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Mon–Fri" or "Mon, Wed, Fri" */
function daysLabel(days) {
  const cap = (d) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1);
  const set = new Set(days);
  // A run of consecutive days like Mon–Fri or Sun–Thu: find where it starts.
  const start = [...set].find((d) => !set.has((d + 6) % 7));
  if (set.size > 2 && start !== undefined) {
    const end = (start + set.size - 1) % 7;
    const isRun = [...Array(set.size).keys()].every((k) => set.has((start + k) % 7));
    if (isRun) return `${cap(start)}–${cap(end)}`;
  }
  return [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(cap).join(", "); // Monday first
}

/** "mon-fri", "mon tue wed", "sun-thu" -> [1,2,3,4,5] etc. null if invalid. */
function parseDays(args) {
  const days = new Set();
  for (const token of args.join(" ").toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    const range = token.split("-");
    const idx = range.map((t) => DAY_NAMES.indexOf(t.slice(0, 3)));
    if (idx.some((i) => i === -1) || idx.length > 2) return null;
    if (idx.length === 1) days.add(idx[0]);
    else for (let d = idx[0]; ; d = (d + 1) % 7) { days.add(d); if (d === idx[1]) break; }
  }
  return days.size ? [...days].sort() : null;
}

// ---------------------------------------------------------------- storage --
// Each group is one JSON object stored under the key "chat:<chat id>":
// { chat_id, title, active, owner_id, owner_username, owner_name,
//   tz, time, workdays, paused, current, last_announced,
//   members: [{name, username, away}], managers: ["username"],
//   perms: {cmd: level}, settings: {...}, user_ids: {username: id}, version }
// last_announced = date of the last reminder. null means "the next reminder
// announces `current` without rotating first" (fresh start or /setturn on a day off).

function newGroup(chat, owner) {
  return normalize({
    chat_id: chat.id,
    title: chat.title || "",
    active: true,
    owner_id: owner?.id ?? null,
    owner_username: owner?.username ?? null,
    owner_name: owner?.first_name ?? "",
    members: [],
  });
}

/** Fill in missing fields, so data saved by older versions keeps working. */
function normalize(g) {
  g.title ??= "";
  g.active ??= true;
  g.owner_id ??= null;
  g.owner_username ??= null;
  g.owner_name ??= "";
  g.tz ??= DEFAULT_TZ;
  g.time ??= DEFAULT_TIME;
  g.workdays ??= [...DEFAULT_WORKDAYS];
  g.paused ??= false;
  g.current ??= 0;
  g.last_announced ??= null;
  g.members ??= [];
  g.managers ??= [];
  g.user_ids ??= {};
  const perms = {};
  for (const [cmd, info] of Object.entries(COMMAND_INFO)) perms[cmd] = g.perms?.[cmd] ?? info[2];
  g.perms = perms;
  g.settings = { ...DEFAULT_SETTINGS, ...(g.settings || {}) };
  g.version = 3;
  return g;
}

let ready = false; // per Worker instance

/** Create tables, and move the old single-group data into the new layout (once). */
async function ensureReady(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pending_delete (chat_id INTEGER, message_id INTEGER, due INTEGER)"
    ),
  ]);
  const legacy = await env.DB.prepare("SELECT v FROM store WHERE k = 'state'").first();
  if (legacy) {
    const old = JSON.parse(legacy.v);
    if (old.chat_id) {
      const g = normalize({ ...old, owner_username: LEGACY_OWNER_USERNAME, active: true });
      delete g.bot_username;
      await saveGroup(env, g);
      // Old version gave people private-chat menus; remove those.
      const ids = new Set([...Object.values(old.user_ids || {}), old.owner_id].filter(Boolean));
      await Promise.all([...ids].map((id) =>
        tg(env, "deleteMyCommands", { scope: { type: "chat", chat_id: id } })));
    }
    if (old.bot_username) await saveMeta(env, { bot_username: old.bot_username });
    await env.DB.prepare("DELETE FROM store WHERE k = 'state'").run();
  }
  ready = true;
}

async function loadGroup(env, chatId) {
  await ensureReady(env);
  const row = await env.DB.prepare("SELECT v FROM store WHERE k = ?1").bind(`chat:${chatId}`).first();
  return row ? normalize(JSON.parse(row.v)) : null;
}

async function saveGroup(env, g) {
  await env.DB.prepare(
    "INSERT INTO store (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(`chat:${g.chat_id}`, JSON.stringify(g)).run();
}

async function deleteGroup(env, chatId) {
  await env.DB.prepare("DELETE FROM store WHERE k = ?1").bind(`chat:${chatId}`).run();
}

async function allGroups(env) {
  await ensureReady(env);
  const { results } = await env.DB.prepare("SELECT v FROM store WHERE k LIKE 'chat:%'").all();
  return results.map((r) => normalize(JSON.parse(r.v)));
}

async function loadMeta(env) {
  await ensureReady(env);
  const row = await env.DB.prepare("SELECT v FROM store WHERE k = 'meta'").first();
  return row ? JSON.parse(row.v) : {};
}

async function saveMeta(env, meta) {
  await env.DB.prepare(
    "INSERT INTO store (k, v) VALUES ('meta', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(JSON.stringify(meta)).run();
}

// --------------------------------------------------------------- rotation --

/** Index of the next person after i who is not away (null if nobody). */
function nextActive(g, i) {
  const n = g.members.length;
  for (let step = 1; step <= n; step++) {
    const j = (i + step) % n;
    if (!g.members[j].away) return j;
  }
  return null;
}

/** Index of the person on duty now, skipping anyone marked away. */
function currentActive(g) {
  const n = g.members.length;
  if (!n) return null;
  const i = g.current % n;
  return g.members[i].away ? nextActive(g, i) : i;
}

const sameUser = (a, b) =>
  String(a || "").replace(/^@/, "").toLowerCase() === String(b || "").replace(/^@/, "").toLowerCase();

function findMember(g, username) {
  const i = g.members.findIndex((m) => sameUser(m.username, username));
  return i === -1 ? null : i;
}

/** [[date, memberIndex], ...] for the next `count` workdays. */
function upcoming(g, count) {
  let d = today(g);
  let i = currentActive(g);
  if (i === null || !g.workdays.length) return [];
  const alreadyToday = isWorkday(g, d) && g.last_announced === d;
  if (!alreadyToday) {
    if (!isWorkday(g, d)) d = nextWorkday(g, d);
    if (g.last_announced !== null) {
      i = nextActive(g, g.current % g.members.length) ?? i;
    }
  }
  const result = [];
  for (let k = 0; k < count; k++) {
    result.push([d, i]);
    d = nextWorkday(g, d);
    i = nextActive(g, i);
  }
  return result;
}

// --------------------------------------------------------------- telegram --

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tag = (m) => `@${esc(m.username)}`;
const label = (m) => `${esc(m.name)} (@${esc(m.username)})`;
const ownerLabel = (g) => (g.owner_username ? `@${esc(g.owner_username)}` : esc(g.owner_name || "the person who added me"));

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.log(`Telegram ${method} failed:`, JSON.stringify(json));
  return json;
}

function send(env, chatId, text, silent, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    disable_notification: !!silent,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/** Secret shared with Telegram so only Telegram can call our webhook. */
async function webhookSecret(env) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.BOT_TOKEN));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ------------------------------------------------------------ clean chat --

async function scheduleDelete(env, chatId, messageId, minutes) {
  await env.DB.prepare("INSERT INTO pending_delete (chat_id, message_id, due) VALUES (?1, ?2, ?3)")
    .bind(chatId, messageId, Date.now() + minutes * 60_000).run();
}

/** Delete bot replies whose time is up (runs every minute). */
async function runPendingDeletes(env) {
  const { results } = await env.DB.prepare(
    `SELECT rowid AS id, chat_id, message_id FROM pending_delete WHERE due <= ?1 LIMIT ${MAX_DELETES_PER_RUN}`
  ).bind(Date.now()).all();
  if (!results.length) return;
  await env.DB.prepare(`DELETE FROM pending_delete WHERE rowid IN (${results.map((r) => r.id).join(",")})`).run();
  await Promise.all(results.map((r) => tg(env, "deleteMessage", { chat_id: r.chat_id, message_id: r.message_id })));
}

/** Can the bot delete other people's messages in this group? */
async function botCanDelete(env, g) {
  const botId = Number(env.BOT_TOKEN.split(":")[0]);
  const res = await tg(env, "getChatMember", { chat_id: g.chat_id, user_id: botId });
  const m = res.result || {};
  return m.status === "creator" || (m.status === "administrator" && !!m.can_delete_messages);
}

const DELETE_WARNING =
  "\n\n⚠️ <b>Clean chat can't delete commands yet.</b> Make the bot a group admin with the " +
  "\"Delete messages\" permission (group info → Administrators → Add admin).";

// ---------------------------------------------------------- announcements --

/** Post today's duty message. If `advance`, rotate to the next person first. */
async function announce(env, g, advance) {
  if (!g.members.length) return;
  if (advance && g.last_announced !== null) {
    const nxt = nextActive(g, g.current % g.members.length);
    if (nxt !== null) g.current = nxt;
  }
  const silent = g.settings.silent_reminder;
  const i = currentActive(g);
  g.last_announced = today(g);
  if (i === null) {
    await saveGroup(env, g);
    await send(env, g.chat_id, "Everyone is marked away, so nobody is on duty today.", silent);
    return;
  }
  g.current = i;
  await saveGroup(env, g);

  const person = g.members[i];
  const nxt = nextActive(g, i);
  let text =
    `☕ Good morning, team!\n\n` +
    `Today's duty person is ${tag(person)} (${esc(person.name)}).\n` +
    `Tea, shopping and food orders are on you today. Thank you! 🙏`;
  if (nxt !== null && nxt !== i) text += `\n\nNext workday: ${esc(g.members[nxt].name)}`;
  const res = await send(env, g.chat_id, text, silent);
  // The bot was removed from the group, or the group was deleted.
  if (!res.ok && [400, 403].includes(res.error_code)) {
    g.active = false;
    await saveGroup(env, g);
  }
}

/** Is this group's reminder due right now? */
function reminderDue(g) {
  if (!g.active || g.paused || !g.members.length) return false;
  const now = nowLocal(g.tz);
  if (!isWorkday(g, now.date) || g.last_announced === now.date || now.hh >= LAST_CATCHUP_HOUR) return false;
  const [hh, mm] = g.time.split(":").map(Number);
  return now.hh > hh || (now.hh === hh && now.mm >= mm);
}

/** Runs every minute: post due reminders in every group, clean up old replies. */
async function minuteTick(env) {
  const groups = await allGroups(env);
  const due = groups.filter(reminderDue).slice(0, MAX_REMINDERS_PER_RUN);
  await Promise.all(due.map((g) => announce(env, g, true)));
  await runPendingDeletes(env);
}

/** Make member i the duty person for today (or the next workday). */
async function giveTurn(c, i) {
  const { env, data } = c;
  data.current = i;
  if (isWorkday(data, today(data))) {
    data.last_announced = today(data);
    await saveGroup(env, data);
    await announce(env, data, false);
  } else {
    data.last_announced = null;
    await saveGroup(env, data);
    await c.reply(`📅 ${label(data.members[i])} will be on duty next workday.`);
  }
}

// ------------------------------------------------------------ permissions --

/** The owner is remembered by Telegram id, so it still works if their username changes. */
const isOwner = (g, user) =>
  g.owner_id ? g.owner_id === user.id : !!g.owner_username && sameUser(user.username, g.owner_username);
const isListedManager = (g, user) =>
  !!user.username && g.managers.some((u) => sameUser(u, user.username));

function roleOf(g, user) {
  if (isOwner(g, user)) return "owner";
  return isListedManager(g, user) ? "managers" : "everyone";
}

function allowed(g, role, cmd) {
  const level = g.perms[cmd];
  return role === "owner" || level === "everyone" || (level === "managers" && role === "managers");
}

// ------------------------------------------------------------- the "/" menu --

const MENU = [
  ["today", "Who is on duty today"],
  ["schedule", "Next 10 workdays"],
  ["list", "Rotation order"],
  ["skip", "Pass today's turn to the next person"],
  ["setturn", "Make someone today's duty person"],
  ["swap", "Swap two people"],
  ["add", "Add a person"],
  ["remove", "Remove a person"],
  ["away", "Temporarily skip a person"],
  ["back", "Return a person to the rotation"],
  ["pause", "Pause reminders"],
  ["resume", "Resume reminders"],
  ["settime", "Change reminder time"],
  ["settimezone", "Change time zone"],
  ["setdays", "Change work days"],
  ["admin", "Control center"],
  ["addmanager", "Make someone a manager"],
  ["removemanager", "Remove a manager"],
  ["help", "All commands"],
];

const OWNER_ONLY = ["admin", "addmanager", "removemanager"];

/** The "/" menu for a role in a group: only the commands that role may use. */
function menuFor(g, role) {
  return MENU.filter(([cmd]) => {
    if (cmd === "help") return true;
    if (OWNER_ONLY.includes(cmd)) return role === "owner";
    return allowed(g, role, cmd);
  }).map(([command, description]) => ({ command, description }));
}

const PRIVATE_MENU = [
  { command: "admin", description: "Control center for your groups" },
  { command: "help", description: "How to use this bot" },
];

/** Give everyone in a group the "/" menu that matches their permissions. */
async function syncMenus(env, g) {
  const known = { ...g.user_ids };
  if (g.owner_id) known[(g.owner_username || "").toLowerCase() || `id${g.owner_id}`] = g.owner_id;
  await Promise.all([
    tg(env, "setMyCommands", { commands: menuFor(g, "everyone"), scope: { type: "chat", chat_id: g.chat_id } }),
    ...Object.entries(known).map(([username, id]) =>
      tg(env, "setMyCommands", {
        commands: menuFor(g, roleOf(g, { id, username })),
        scope: { type: "chat_member", chat_id: g.chat_id, user_id: id },
      })),
  ]);
}

// --------------------------------------------------------------- commands --

function helpText(g) {
  const groups = { everyone: ["/help - this message"], managers: [], owner: [] };
  for (const [cmd, [usage, desc]] of Object.entries(COMMAND_INFO)) {
    groups[g.perms[cmd]].push(`${esc(usage)} - ${esc(desc)}`);
  }
  let text =
    `<b>Daily Duty Bot</b> - reminds the team at ${g.time} (${esc(g.tz)}), ${daysLabel(g.workdays)}.\n`;
  const titles = { everyone: "For everyone", managers: "For managers", owner: "Owner only" };
  for (const level of LEVELS) {
    if (groups[level].length) text += `\n<b>${titles[level]}</b>\n${groups[level].join("\n")}\n`;
  }
  text += `\n⚙️ Owner: ${ownerLabel(g)}. Permissions and settings: /admin in a private chat with me.`;
  return text;
}

const PRIVATE_HELP =
  "<b>Daily Duty Bot</b> 👋\n\n" +
  "I rotate daily duties (tea, shopping, food orders) in your team's group and tag " +
  "whoever's turn it is every workday.\n\n" +
  "<b>Get started</b>\n" +
  "1. Add me to your group. You become my owner there.\n" +
  "2. In the group, add your team: <code>/add Full Name @username</code>\n" +
  "3. Optional: change the time, time zone and work days with /settime, /settimezone, /setdays.\n" +
  "4. Make me a group admin with \"Delete messages\" to keep the chat clean.\n\n" +
  "Send /admin here to manage permissions and settings for your groups.";

function welcomeText(g) {
  return (
    "👋 <b>Hi! I'm the Daily Duty Bot.</b>\n\n" +
    "Every workday I tag whoever's turn it is for tea, shopping and food orders.\n\n" +
    `👑 Owner in this group: ${ownerLabel(g)}\n` +
    `⏰ Reminder: ${g.time} (${esc(g.tz)}), ${daysLabel(g.workdays)}\n\n` +
    "<b>Setup</b>\n" +
    "1. Add your team, one by one: <code>/add Full Name @username</code>\n" +
    "2. Check the order: /list and /schedule\n" +
    "3. Change the time, time zone or days: /settime 09:00, /settimezone Asia/Tashkent, /setdays mon-fri\n" +
    "4. Owner: open /admin in a private chat with me for permissions and settings.\n\n" +
    "💡 Make me a group admin with \"Delete messages\" so I can keep the chat clean."
  );
}

const COMMANDS = {
  async help(c) {
    await c.reply(helpText(c.data));
  },

  async today(c) {
    const { data } = c;
    const d = today(data);
    if (!data.members.length) return c.reply("The team is empty. Add people with /add Full Name @username");
    if (!isWorkday(data, d)) return c.reply("Today is a day off - no duty. 😎");
    if (data.last_announced !== d) {
      const up = upcoming(data, 1);
      if (!up.length) return c.reply("Nobody is available.");
      return c.reply(
        `Today's reminder hasn't gone out yet (${data.time}). It will be: ${label(data.members[up[0][1]])}`
      );
    }
    const i = currentActive(data);
    if (i === null) return c.reply("Nobody is available.");
    await c.reply(`Today's duty person: ${label(data.members[i])}`);
  },

  async schedule(c) {
    const { data } = c;
    const rows = upcoming(data, 10).map(([d, i]) => `${prettyDate(d)} - ${esc(data.members[i].name)}`);
    if (!rows.length) return c.reply("Nobody is available. Add people with /add Full Name @username");
    let text = "<b>Upcoming duty</b>\n" + rows.join("\n");
    if (data.paused) text += "\n\n⏸ Reminders are paused right now.";
    await c.reply(text);
  },

  async list(c) {
    const { data } = c;
    const cur = currentActive(data);
    const rows = data.members.map((m, i) =>
      `${i + 1}. ${label(m)}${m.away ? " (away)" : ""}${i === cur ? " 👈 current" : ""}`
    );
    await c.reply("<b>Rotation order</b>\n" + (rows.join("\n") || "(empty - add people with /add Full Name @username)"));
  },

  async skip(c) {
    const up = upcoming(c.data, 2);
    if (up.length < 2 || up[0][1] === up[1][1]) return c.reply("There is nobody else to pass the turn to.");
    await c.reply(`⏭ Skipped ${esc(c.data.members[up[0][1]].name)}.`);
    await giveTurn(c, up[1][1]);
  },

  async setturn(c) {
    const i = c.args.length === 1 ? findMember(c.data, c.args[0]) : null;
    if (i === null) return c.reply("Usage: /setturn @username (must be in /list)");
    c.data.members[i].away = false;
    await giveTurn(c, i);
  },

  async swap(c) {
    const { data } = c;
    if (c.args.length !== 2) return c.reply("Usage: /swap @user1 @user2");
    const a = findMember(data, c.args[0]);
    const b = findMember(data, c.args[1]);
    if (a === null || b === null) return c.reply("Both people must be in /list.");
    [data.members[a], data.members[b]] = [data.members[b], data.members[a]];
    // "current" keeps pointing at the same position, so if today's person
    // was swapped, the other person takes today's turn.
    await saveGroup(c.env, data);
    await c.reply(`🔄 Swapped ${esc(data.members[b].name)} and ${esc(data.members[a].name)}.`);
  },

  async add(c) {
    const { data, args } = c;
    if (args.length < 2 || !args[args.length - 1].startsWith("@")) {
      return c.reply("Usage: /add Full Name @username");
    }
    const username = args[args.length - 1].replace(/^@/, "");
    if (findMember(data, username) !== null) return c.reply("That person is already in the list.");
    data.members.push({ name: args.slice(0, -1).join(" "), username, away: false });
    await saveGroup(c.env, data);
    await c.reply(`✅ Added ${label(data.members[data.members.length - 1])} to the end of the list.`);
  },

  async remove(c) {
    const { data } = c;
    const i = c.args.length === 1 ? findMember(data, c.args[0]) : null;
    if (i === null) return c.reply("Usage: /remove @username (must be in /list)");
    const [removed] = data.members.splice(i, 1);
    if (i < data.current) data.current -= 1;
    else if (i === data.current) {
      // Today's person left: the next person in line takes over.
      data.current = data.members.length ? data.current % data.members.length : 0;
    }
    await saveGroup(c.env, data);
    await c.reply(`🗑 Removed ${label(removed)}.`);
  },

  async away(c) {
    await setAway(c, true);
  },

  async back(c) {
    await setAway(c, false);
  },

  async pause(c) {
    c.data.paused = true;
    await saveGroup(c.env, c.data);
    await c.reply("⏸ Daily reminders paused. Use /resume to start again.");
  },

  async resume(c) {
    c.data.paused = false;
    await saveGroup(c.env, c.data);
    await c.reply("▶️ Daily reminders resumed.");
  },

  async settime(c) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(c.args[0] || "");
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      return c.reply("Usage: /settime HH:MM  (for example /settime 09:00)");
    }
    c.data.time = `${m[1].padStart(2, "0")}:${m[2]}`;
    await saveGroup(c.env, c.data);
    await c.reply(`⏰ Daily reminder time set to ${c.data.time} (${esc(c.data.tz)}).`);
  },

  async settimezone(c) {
    const tz = c.args[0] || "";
    if (!tz || !validTimeZone(tz)) {
      return c.reply(
        "Usage: /settimezone Area/City\nExamples: Asia/Tashkent, Europe/Moscow, Asia/Almaty, Europe/London\n" +
          "Full list: en.wikipedia.org/wiki/List_of_tz_database_time_zones"
      );
    }
    c.data.tz = tz;
    await saveGroup(c.env, c.data);
    const now = nowLocal(tz);
    await c.reply(
      `🌍 Time zone set to ${esc(tz)}. Local time there is now ` +
        `${String(now.hh).padStart(2, "0")}:${String(now.mm).padStart(2, "0")}.`
    );
  },

  async setdays(c) {
    const days = parseDays(c.args);
    if (!days) {
      return c.reply("Usage: /setdays mon-fri\nOther examples: /setdays sun-thu, /setdays mon tue wed thu");
    }
    c.data.workdays = days;
    await saveGroup(c.env, c.data);
    await c.reply(`📅 Work days set to ${daysLabel(days)}.`);
  },
};
COMMANDS.start = COMMANDS.help;

async function setAway(c, away) {
  const { data } = c;
  const cmd = away ? "/away" : "/back";
  const i = c.args.length === 1 ? findMember(data, c.args[0]) : null;
  if (i === null) return c.reply(`Usage: ${cmd} @username (must be in /list)`);
  const wasOnDuty = currentActive(data) === i;
  data.members[i].away = away;
  await saveGroup(c.env, data);
  const m = data.members[i];
  if (!away) return c.reply(`👋 ${label(m)} is back in the rotation.`);
  let text = `🤒 ${label(m)} is away and will be skipped until /back.`;
  if (wasOnDuty && data.last_announced === today(data)) {
    text += "\nThey were on duty today - use /skip to pass today's turn on.";
  }
  await c.reply(text);
}

// --------------------------------------------- owner & control center --

const OWNER_COMMANDS = {
  async admin(c) {
    if (!isOwner(c.data, c.from)) return c.reply("🔒 Only the owner can open the control center.");
    const panel = renderPanel(c.data, "main", await botCanDelete(c.env, c.data));
    const res = await send(c.env, c.from.id, panel.text, false, { reply_markup: { inline_keyboard: panel.keyboard } });
    if (res.ok) return c.reply("📬 I sent you the control center in a private chat.");
    const meta = await loadMeta(c.env);
    const link = meta.bot_username ? ` (t.me/${meta.bot_username})` : "";
    await c.reply(`Open a private chat with me${link}, press Start, then send /admin again.`);
  },

  async addmanager(c) {
    if (!isOwner(c.data, c.from)) return c.reply("🔒 Only the owner can add managers.");
    const u = (c.args[0] || "").replace(/^@/, "");
    if (!u) return c.reply("Usage: /addmanager @username");
    if (!c.data.managers.some((m) => sameUser(m, u))) c.data.managers.push(u);
    await saveGroup(c.env, c.data);
    await c.reply(`⭐ @${esc(u)} is now a manager.`);
    await syncMenus(c.env, c.data);
  },

  async removemanager(c) {
    if (!isOwner(c.data, c.from)) return c.reply("🔒 Only the owner can remove managers.");
    const u = (c.args[0] || "").replace(/^@/, "");
    if (!u) return c.reply("Usage: /removemanager @username");
    c.data.managers = c.data.managers.filter((m) => !sameUser(m, u));
    await saveGroup(c.env, c.data);
    await c.reply(`@${esc(u)} is no longer a manager.`);
    await syncMenus(c.env, c.data);
  },
};

const btn = (text, data) => ({ text, callback_data: data });

/** Text + inline keyboard for one screen of a group's control center. */
function renderPanel(g, screen, canDelete = null) {
  const id = g.chat_id;
  const back = [btn("⬅️ Back", `${id}|nav:main`)];
  const title = esc(g.title || "your group");

  if (screen === "perms") {
    return {
      text:
        `<b>🔐 Command permissions</b> - ${title}\n\nTap a command to change who can use it:\n` +
        "👥 Everyone → ⭐ Managers → 👑 Owner only",
      keyboard: [
        ...Object.keys(COMMAND_INFO).map((cmd) => [btn(`/${cmd}  —  ${LEVEL_LABEL[g.perms[cmd]]}`, `${id}|perm:${cmd}`)]),
        back,
      ],
    };
  }

  if (screen === "managers") {
    const rows = [];
    const teamButtons = g.members.map((m) => {
      const on = g.managers.some((u) => sameUser(u, m.username));
      return btn(`${on ? "⭐" : "▫️"} ${m.name}`, `${id}|mgr:${m.username}`);
    });
    for (let k = 0; k < teamButtons.length; k += 2) rows.push(teamButtons.slice(k, k + 2));
    for (const u of g.managers) {
      if (findMember(g, u) === null) rows.push([btn(`⭐ @${u}  (tap to remove)`, `${id}|mgr:${u}`)]);
    }
    rows.push(back);
    return {
      text:
        `<b>⭐ Managers</b> - ${title}\n\nTap a person to make them a manager (⭐) or not (▫️).\n` +
        "Managers can use every command set to ⭐ Managers.\n\n" +
        "To add someone who isn't in the team list, send this in the group:\n<code>/addmanager @username</code>",
      keyboard: rows,
    };
  }

  if (screen === "settings") {
    const s = g.settings;
    return {
      text:
        `<b>⚙️ Settings</b> - ${title}\n\n` +
        "🔕 <b>Silent</b> - messages arrive without sound or vibration.\n" +
        `🧹 <b>Clean chat</b> - commands are deleted right away, bot replies after ${CLEAN_DELAY_MIN} min. ` +
        "The daily reminder is never deleted." +
        (s.clean_chat && canDelete === false ? DELETE_WARNING : ""),
      keyboard: [
        ...Object.keys(DEFAULT_SETTINGS).map((k) => [btn(`${SETTING_LABEL[k]}: ${s[k] ? "✅ ON" : "❌ OFF"}`, `${id}|set:${k}`)]),
        back,
      ],
    };
  }

  // main screen
  return {
    text:
      `<b>🛠 Control center</b> - ${title}\n\n` +
      `👑 Owner: ${ownerLabel(g)}\n` +
      `👥 Team: ${g.members.length} people\n` +
      `⭐ Managers: ${g.managers.length ? g.managers.map((u) => "@" + esc(u)).join(", ") : "none"}\n` +
      `⏰ Reminder: ${g.time} (${esc(g.tz)}), ${daysLabel(g.workdays)}${g.paused ? " (paused ⏸)" : ""}\n` +
      `🧹 Clean chat: ${g.settings.clean_chat ? "ON" : "OFF"}` +
      (g.settings.clean_chat && canDelete === false ? DELETE_WARNING : "") +
      "\n\nTime, time zone and work days are changed in the group with /settime, /settimezone and /setdays.",
    keyboard: [
      [btn("🔐 Permissions", `${id}|nav:perms`), btn("⭐ Managers", `${id}|nav:managers`)],
      [btn("⚙️ Settings", `${id}|nav:settings`)],
    ],
  };
}

/** /admin in a private chat: open the control center for the user's group(s). */
async function privateAdmin(env, msg) {
  const mine = (await allGroups(env)).filter((g) => g.active && isOwner(g, msg.from));
  if (!mine.length) {
    return send(env, msg.chat.id, "You don't own any groups yet. Add me to a group - the person who adds me becomes the owner there.", false);
  }
  if (mine.length === 1) {
    const panel = renderPanel(mine[0], "main", await botCanDelete(env, mine[0]));
    return send(env, msg.chat.id, panel.text, false, { reply_markup: { inline_keyboard: panel.keyboard } });
  }
  return send(env, msg.chat.id, "<b>🛠 Control center</b>\n\nWhich group?", false, {
    reply_markup: { inline_keyboard: mine.map((g) => [btn(g.title || String(g.chat_id), `${g.chat_id}|nav:main`)]) },
  });
}

/** Button presses in the control center. */
async function handleCallback(env, cq) {
  const answer = (text) =>
    tg(env, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) });
  const [chatId, action = ""] = (cq.data || "").split("|");
  const g = chatId ? await loadGroup(env, chatId) : null;
  if (!g) return answer("This group is no longer available.");
  if (!isOwner(g, cq.from)) return answer("Only the owner can do this.");

  const [kind, arg] = action.split(/:(.*)/s);
  let screen = "main";
  if (kind === "nav") {
    screen = arg;
  } else if (kind === "perm" && COMMAND_INFO[arg]) {
    const cur = LEVELS.indexOf(g.perms[arg]);
    g.perms[arg] = LEVELS[(cur + 1) % LEVELS.length];
    await saveGroup(env, g);
    screen = "perms";
  } else if (kind === "mgr" && arg) {
    const on = g.managers.some((u) => sameUser(u, arg));
    g.managers = on ? g.managers.filter((u) => !sameUser(u, arg)) : [...g.managers, arg];
    await saveGroup(env, g);
    screen = "managers";
  } else if (kind === "set" && arg in DEFAULT_SETTINGS) {
    g.settings[arg] = !g.settings[arg];
    await saveGroup(env, g);
    screen = "settings";
  }
  const canDelete = ["main", "settings"].includes(screen) ? await botCanDelete(env, g) : null;
  const panel = renderPanel(g, screen, canDelete);
  await tg(env, "editMessageText", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    text: panel.text, parse_mode: "HTML", reply_markup: { inline_keyboard: panel.keyboard },
  });
  await answer();
  if (kind === "perm" || kind === "mgr") await syncMenus(env, g);
}

// ----------------------------------------------------- joining and leaving --

/** The bot was added to or removed from a chat. */
async function handleMembership(env, upd) {
  const chat = upd.chat;
  if (!["group", "supergroup"].includes(chat.type)) return;
  const status = upd.new_chat_member?.status;
  const inChat = ["member", "administrator"].includes(status);
  let g = await loadGroup(env, chat.id);

  if (!inChat) {
    if (g) { g.active = false; await saveGroup(env, g); }
    return;
  }
  const wasIn = ["member", "administrator"].includes(upd.old_chat_member?.status);
  if (wasIn && g) return; // e.g. the bot was made admin - nothing to do

  if (!g) {
    g = newGroup(chat, upd.from); // whoever added the bot is the owner
  } else {
    g.active = true; // added back: keep the team, settings and owner
    g.title = chat.title || g.title;
  }
  await saveGroup(env, g);
  await syncMenus(env, g);
  await send(env, chat.id, welcomeText(g), true);
}

/** A group became a supergroup and got a new id: move its data. */
async function handleMigration(env, msg) {
  const g = await loadGroup(env, msg.chat.id);
  if (!g) return;
  await deleteGroup(env, g.chat_id);
  g.chat_id = msg.migrate_to_chat_id;
  await saveGroup(env, g);
  await syncMenus(env, g);
}

// --------------------------------------------------------- message router --

async function handleMessage(env, msg) {
  if (msg.migrate_to_chat_id) return handleMigration(env, msg);
  const text = msg.text || "";
  if (!text.startsWith("/") || !msg.from) return;
  const [first, ...args] = text.trim().split(/\s+/);
  const [rawName, target] = first.slice(1).split("@");
  const name = rawName.toLowerCase();
  const handler = COMMANDS[name] || OWNER_COMMANDS[name];
  if (!handler) return;

  const meta = await loadMeta(env);
  // "/today@OtherBot" is meant for a different bot - ignore it.
  if (target && meta.bot_username && !sameUser(target, meta.bot_username)) return;

  // Private chat: only help and the control center.
  if (msg.chat.type === "private") {
    if (name === "admin") return privateAdmin(env, msg);
    if (name === "help" || name === "start") return send(env, msg.chat.id, PRIVATE_HELP, false);
    return send(env, msg.chat.id, "Please use this command in your group.", false);
  }

  let data = await loadGroup(env, msg.chat.id);
  if (!data) {
    // Missed the "bot was added" event: the first person to use it becomes the owner.
    data = newGroup(msg.chat, msg.from);
    await saveGroup(env, data);
  }
  if (!data.active) data.active = true;
  if (msg.chat.title && data.title !== msg.chat.title) data.title = msg.chat.title;

  // Remember who is who, so managers and the owner get their own "/" menu.
  const uname = (msg.from.username || "").toLowerCase();
  if (isOwner(data, msg.from) && !data.owner_id) data.owner_id = msg.from.id;
  if (isOwner(data, msg.from) && uname) data.owner_username = msg.from.username;
  if (uname && data.user_ids[uname] !== msg.from.id) {
    data.user_ids[uname] = msg.from.id;
    await saveGroup(env, data);
    if (roleOf(data, msg.from) !== "everyone") await syncMenus(env, data);
  }

  const chatId = msg.chat.id;
  const c = {
    env, args, chatId, data,
    from: msg.from,
    sent: [], // ids of our replies, for clean chat
    async reply(t) {
      const r = await send(env, chatId, t, data.settings.silent_replies, {
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
      if (r.ok) c.sent.push(r.result.message_id);
      return r;
    },
  };

  if (COMMAND_INFO[name] && !allowed(data, roleOf(data, msg.from), name)) {
    const level = data.perms[name];
    await c.reply(level === "owner" ? `🔒 Only the owner can use /${name}.` : `🔒 Only managers can use /${name}.`);
  } else {
    await handler(c);
  }
  await cleanUp(c, msg);
}

/** Clean chat: remove the command now and our replies a bit later. */
async function cleanUp(c, msg) {
  const { env, data } = c;
  if (!data.settings.clean_chat) return;
  await tg(env, "deleteMessage", { chat_id: c.chatId, message_id: msg.message_id });
  for (const id of c.sent) await scheduleDelete(env, c.chatId, id, CLEAN_DELAY_MIN);
}

// ------------------------------------------------------------ entrypoints --

export default {
  // Telegram sends every update here (webhook). Also serves /init.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN secret is not set.", { status: 500 });
    if (!env.DB) return new Response("D1 binding 'DB' is not set.", { status: 500 });

    if (url.pathname === "/init") {
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: await webhookSecret(env),
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      });
      await ensureReady(env);
      const meta = await loadMeta(env);
      const me = await tg(env, "getMe", {});
      if (me.ok) meta.bot_username = me.result.username;
      await saveMeta(env, meta);
      await tg(env, "setMyCommands", { commands: PRIVATE_MENU }); // default menu (private chats)
      const groups = (await allGroups(env)).filter((g) => g.active);
      for (const g of groups) await syncMenus(env, g);
      return new Response(
        hook.ok
          ? `✅ Bot is connected to Telegram. ${groups.length} group(s) active.`
          : "❌ " + JSON.stringify(hook),
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const update = await request.json();
        if (update.message) await handleMessage(env, update.message);
        else if (update.callback_query) await handleCallback(env, update.callback_query);
        else if (update.my_chat_member) await handleMembership(env, update.my_chat_member);
      } catch (err) {
        console.log("Error handling update:", err.stack || err);
      }
      return new Response("ok"); // always 200, so Telegram doesn't resend
    }

    return new Response("Daily Duty Bot is running. Open /init once to connect it to Telegram.");
  },

  // Cron trigger (every minute).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(minuteTick(env));
  },
};
