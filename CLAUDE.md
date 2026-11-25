# NavbatGo - Telegram duty-rotation bot

Context for AI agents and developers working on this repo. Read this first.

## What the bot does

A Telegram bot that rotates daily office duties (making tea, shopping, ordering
food) among a team. Every work day at a set time it tags the person on duty in
the group chat. "Navbatchi" (Uzbek for "person on duty") is the bot's display
name; the Telegram handle is `@Choy_Damla_Bot`.

Any Telegram group can add the bot. Each group is independent: its own team,
rotation, owner, managers, permissions, reminder time, time zone, work days
and settings.

## Owner and people

- Repo owner / product owner: **Alan7w** on GitHub, `@asadxonrasulov` on
  Telegram. He's a beginner developer: explain steps plainly,
  keep things simple, and ask before serious or irreversible decisions.
- His original work group was the first user. Its data was migrated from the
  single-group version (see "Data model"). He's the owner of that group.

## Hosting and deployment

- Runs on **Cloudflare Workers, free plan** (no credit card). Chosen because it's
  free, always on, and webhook-based (Telegram pushes updates to us), so nothing
  needs to run 24/7.
  - Free limits: 100k requests/day, 10 ms CPU per request, 50 outside
    subrequests per invocation, D1 5 GB total / 500 MB per DB, 5M rows read and
    100k rows written per day, 5 cron triggers per account.
- Worker name: `duty-bot`. URL: `https://duty-bot.asadbek7humans.workers.dev`.
- Database: **Cloudflare D1** `duty-bot-db`, bound as `DB`.
- Secret: `BOT_TOKEN` (from @BotFather), stored in Cloudflare only.
  **Never commit tokens or passwords.** The repo is public.
- Cron trigger `* * * * *`: runs every minute. The code decides per group
  whether a reminder is due.
- **Deploys are automatic:** a push to `main` runs `.github/workflows/deploy.yml`,
  which runs the tests and then `wrangler deploy`. It needs the GitHub repo
  secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **After a deploy that changes webhook settings, the command menu or the
  allowed update types, open `https://duty-bot.asadbek7humans.workers.dev/init`
  once.** It sets the webhook, `allowed_updates`, the command menus and the
  stored bot username. It's safe to open any time.

## Code layout

- `src/index.js`: the whole bot, a single ES module Worker with `fetch`
  (webhook + `/init`) and `scheduled` (cron).
- `tests/harness.mjs`: runs the real Worker against real SQLite (shaped like D1)
  and a fake Telegram API that records every call.
- `tests/bot.test.mjs`: behaviour tests. **Run `npm test` before every commit.**
  It needs Node 22.13+ (uses `node:sqlite`) and has no dependencies.
- `wrangler.toml`: Worker config (D1 binding, cron).
- `assets/`: the bot's profile picture (SVG source and PNG).

## Data model (D1)

- Table `store (k TEXT PRIMARY KEY, v TEXT)`:
  - `chat:<telegram chat id>` → JSON for one group:
    `{ chat_id, title, active, owner_id, owner_username, owner_name, tz, time,
       workdays: [0-6, 0=Sun], paused, current, last_announced,
       members: [{name, username, away}], managers: [username],
       perms: {command: "everyone"|"managers"|"owner"},
       settings: {silent_reminder, silent_replies, clean_chat},
       user_ids: {username_lowercase: telegram_id}, version }`
  - `meta` → `{ bot_username }`
  - `state` → the **old single-group format**. `ensureReady()` migrates it to
    `chat:<id>` automatically and deletes it.
- Table `pending_delete (chat_id, message_id, due)`: bot replies to delete
  later (clean chat).
- `last_announced` is the date (in the group's time zone) of the last reminder.
  `null` means "the next reminder announces `current` without rotating first".
  This is used for brand-new groups and for `/setturn` or `/skip` on a day off.
- `normalize()` fills in missing fields, so old saved data keeps working. When
  you add a field, add a default there.

## Behaviour and decisions (agreed with the owner)

- **Ownership:** whoever adds the bot to a group becomes its owner. It's
  identified by Telegram user id, so it survives username changes. Re-adding
  the bot keeps the original owner and data. Telegram group admin status gives
  **no** rights; the owner chose this explicitly.
- **Permissions:** per group and per command, each set to everyone, managers
  or owner. Defaults are in `COMMAND_INFO`. `/admin`, `/addmanager` and
  `/removemanager` are always owner-only. Managers are chosen by username.
- **Control center:** `/admin` in a private chat shows inline-button screens
  (Permissions, Managers, Settings). Callback data is
  `<chatId>|<kind>:<arg>`, which must fit Telegram's 64-byte limit.
- **"/" menu:** set per person with `setMyCommands` scopes, so people only see
  commands they may use: `chat` scope for regular members, `chat_member`
  scope for owner and managers. The bot only learns a user's id when they send
  a command (privacy mode), so a new manager's menu updates after their first
  command.
- **Silent messages:** `disable_notification` is on by default for both the
  reminder and replies, as the owner asked. A bot can't silence messages that
  people type themselves.
- **Clean chat** is on by default. The user's command is deleted at once
  (needs the bot to be a group admin with "Delete messages") and bot replies
  are deleted after 2 minutes through `pending_delete` and the cron. The daily
  reminder is never deleted.
- **Work days and time:** per group. Defaults are 09:00, `Asia/Tashkent`,
  Mon–Fri. Missed reminders are caught up until 18:00 local time.
- **Free-plan safety:** at most 25 reminders and 20 deletions per cron run.
  Leftovers go out the next minute.
- If sending a reminder fails with 400/403, the group is marked inactive. The
  bot was removed or the group deleted.

## Roadmap: next task, a web admin panel

The owner asked for this. These decisions have been made:
- Served by the same Worker (for example under `/panel`), so it stays free.
- **Login: password for the owner (super admin) only.** Store it as a
  Cloudflare secret (for example `PANEL_PASSWORD`), never in the repo. Use a
  signed, expiring session cookie and rate-limit login attempts.
- Scope: **"include as many settings as possible"**:
  - **Super-admin view:** all groups, stats (members, active, last reminder),
    pause, resume or remove any group.
  - **Group management:** team (add, remove, reorder, away), schedule,
    managers, permissions, time, time zone, work days, settings.
  - **Editable message texts** per group (reminder, welcome, …) with
    placeholders like `{name}` and `{username}`, so texts aren't hard-coded.
  - **Bot-wide defaults** for new groups (time, time zone, days, settings,
    permissions), stored in D1, for example under a `config` key.
- Goal: make the bot data-driven, so changing behaviour doesn't need code edits.

## Working conventions

- Keep it simple: plain JavaScript, no framework or build step, no runtime
  dependencies.
- Add or update tests in `tests/bot.test.mjs` for every behaviour change, and
  run `npm test`.
- Use the Telegram HTML parse mode and escape user text with `esc()`.
- All D1 access goes through the helpers (`loadGroup`, `saveGroup`, `allGroups`,
  `loadMeta`, `saveMeta`).
- Don't put real coworkers' names or usernames in the repo. It's public.
