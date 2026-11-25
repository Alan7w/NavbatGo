import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, user } from "./harness.mjs";

const owner = user(10, "team_owner");
const dev = user(11, "team_dev");
const other = user(20, "other_owner");
const GROUP = -200;

/** A group with three people, created by `owner`. */
async function groupWithTeam(h, chatId = GROUP) {
  await h.membership(owner, chatId);
  for (const [name, u] of [["Ann", "ann"], ["Bob", "bob"], ["Cid", "cid"]]) {
    await h.say(owner, `/add ${name} @${u}`, chatId);
  }
}

test("adding the bot makes the adder the owner and posts a welcome", async () => {
  const h = await createHarness();
  const out = await h.membership(owner, GROUP);
  assert.equal(h.group(GROUP).owner_id, owner.id);
  assert.equal(h.group(GROUP).members.length, 0);
  assert.match(out.find((c) => c.method === "sendMessage").text, /Hi! I'm the Daily Duty Bot/);
});

test("making the bot an admin does not post a second welcome", async () => {
  const h = await createHarness();
  await h.membership(owner, GROUP);
  const out = await h.membership(owner, GROUP, "administrator", "member");
  assert.equal(out.filter((c) => c.method === "sendMessage").length, 0);
});

test("permissions: regular members can view but not manage", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  assert.match((await h.say(dev, "/add X @x", GROUP))[0].text, /Only managers/);
  assert.match((await h.say(dev, "/list", GROUP))[0].text, /Rotation order/);
  assert.match((await h.say(owner, "/settimezone Europe/London", GROUP))[0].text, /Time zone set/);
  assert.match((await h.say(dev, "/settimezone Asia/Tokyo", GROUP))[0].text, /Only the owner/);
});

test("owners cannot control each other's groups", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  const out = await h.press(other, `${GROUP}|perm:today`);
  assert.match(out.find((c) => c.method === "answerCallbackQuery").text, /Only the owner/);
});

test("control center: owner changes a permission and menus follow", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  await h.press(owner, `${GROUP}|perm:skip`); // managers -> owner
  assert.equal(h.group(GROUP).perms.skip, "owner");
  await h.press(owner, `${GROUP}|perm:skip`); // owner -> everyone
  assert.match((await h.say(dev, "/skip", GROUP))[0].text, /Skipped/);
  const menu = h.calls.filter((c) => c.method === "setMyCommands" && c.scope?.type === "chat" && c.scope.chat_id === GROUP).at(-1);
  assert.ok(menu.commands.some((c) => c.command === "skip"));
});

test("reminders rotate on work days at each group's local time", async () => {
  const h = await createHarness();
  await groupWithTeam(h); // Tashkent, Mon-Fri, 09:00 = 04:00 UTC
  await groupWithTeam(h, -300);
  await h.say(owner, "/settimezone Europe/London", -300);
  await h.say(owner, "/setdays sun-thu", -300);

  const sent = await h.runUntil(Date.UTC(2026, 10, 30, 12, 0)); // Wed 25 -> Mon 30 Nov
  const tashkent = sent.filter((s) => s.chat === GROUP);
  const london = sent.filter((s) => s.chat === -300);
  assert.deepEqual(tashkent.map((s) => s.who), ["ann", "bob", "cid", "ann"]); // Wed Thu Fri Mon
  assert.ok(tashkent.every((s) => s.at.slice(11, 16) === "04:00"));
  assert.deepEqual(london.map((s) => s.at.slice(0, 10)), ["2026-11-25", "2026-11-26", "2026-11-29", "2026-11-30"]); // no Fri/Sat
  assert.ok(london.every((s) => s.at.slice(11, 16) === "09:00"));
});

test("/skip, /away and /setturn change who is on duty", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  await h.runUntil(Date.UTC(2026, 10, 25, 4, 1)); // Wed reminder: ann
  await h.say(owner, "/skip", GROUP); // -> bob
  assert.equal(h.group(GROUP).members[h.group(GROUP).current].username, "bob");
  await h.say(owner, "/away @cid", GROUP);
  const next = await h.runUntil(Date.UTC(2026, 10, 26, 4, 1)); // Thu: cid away -> ann
  assert.equal(next.at(-1).who, "ann");
  await h.say(owner, "/setturn @cid", GROUP);
  assert.equal(h.group(GROUP).members[h.group(GROUP).current].username, "cid");
});

test("a removed bot stops posting; re-adding keeps team and owner", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  await h.membership(owner, GROUP, "left", "member");
  assert.equal(h.group(GROUP).active, false);
  assert.equal((await h.runUntil(Date.UTC(2026, 10, 25, 5, 0))).length, 0);
  await h.membership(dev, GROUP); // someone else re-adds it
  assert.equal(h.group(GROUP).owner_id, owner.id);
  assert.equal(h.group(GROUP).members.length, 3);
});

test("a failed reminder (bot kicked silently) marks the group inactive", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  h.failChats.add(GROUP);
  await h.runUntil(Date.UTC(2026, 10, 25, 4, 1));
  assert.equal(h.group(GROUP).active, false);
});

test("group upgraded to supergroup keeps its data under the new id", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  await h.update({ message: { message_id: 1, chat: { id: GROUP, type: "group" }, migrate_to_chat_id: -1009, from: owner } });
  assert.equal(h.group(GROUP), null);
  assert.equal(h.group(-1009).members.length, 3);
});

test("clean chat deletes the command now and the reply after 2 minutes", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  const out = await h.update({ message: { message_id: 77, text: "/list", from: dev, chat: { id: GROUP, type: "supergroup" } } });
  assert.ok(out.some((c) => c.method === "deleteMessage" && c.message_id === 77));
  const replyId = h.calls.filter((c) => c.method === "sendMessage" && c.ok).length + 999;
  h.now += 60_000;
  assert.ok(!(await h.tick()).some((c) => c.method === "deleteMessage" && c.message_id === replyId));
  h.now += 60_000;
  assert.ok((await h.tick()).some((c) => c.method === "deleteMessage" && c.message_id === replyId));
});

test("bot messages are silent by default", async () => {
  const h = await createHarness();
  await groupWithTeam(h);
  const out = await h.say(dev, "/today", GROUP);
  assert.equal(out[0].disable_notification, true);
});

test("many groups due at once are spread over minutes (free-plan limit)", async () => {
  const h = await createHarness();
  for (let k = 0; k < 30; k++) {
    await h.membership(owner, -5000 - k);
    await h.say(owner, `/add A @a${k}`, -5000 - k);
  }
  h.now = Date.UTC(2026, 10, 25, 4, 0);
  const first = (await h.tick()).filter((c) => c.method === "sendMessage").length;
  h.now += 60_000;
  const second = (await h.tick()).filter((c) => c.method === "sendMessage").length;
  assert.equal(first, 25);
  assert.equal(second, 5);
});

test("old single-group data is migrated on first run", async () => {
  const h = await createHarness();
  h.db.exec("CREATE TABLE store (k TEXT PRIMARY KEY, v TEXT)");
  h.db.prepare("INSERT INTO store VALUES ('state', ?)").run(JSON.stringify({
    chat_id: -100, time: "09:00", current: 2, last_announced: "2026-11-24", owner_id: 1,
    members: [{ name: "A", username: "a", away: false }, { name: "B", username: "b", away: false }, { name: "C", username: "c", away: false }],
    managers: ["b"], perms: { list: "managers" }, settings: { clean_chat: true }, user_ids: { a: 1 }, bot_username: "X",
  }));
  assert.match(await h.init(), /1 group\(s\) active/);
  const g = h.group(-100);
  assert.equal(g.owner_id, 1);
  assert.equal(g.current, 2);
  assert.deepEqual(g.managers, ["b"]);
  assert.equal(g.perms.list, "managers");
  assert.equal(h.db.prepare("SELECT 1 FROM store WHERE k = 'state'").get(), undefined);
});

test("webhook rejects requests without Telegram's secret", async () => {
  const h = await createHarness();
  const res = await h.worker.fetch(new Request("https://bot.test/webhook", { method: "POST", body: "{}" }), h.env);
  assert.equal(res.status, 403);
});
