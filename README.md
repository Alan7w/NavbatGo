# NavbatGo 🫖

A Telegram bot that takes the "whose turn is it?" out of office duties. Every
work day it tags the person on duty (making tea, shopping, ordering food) in
your group, and rotates fairly through the team.

<img src="assets/avatar.png" width="120" alt="Bot avatar">

- Runs free on **Cloudflare Workers** with a **D1** database
- Any group can add it. Each group has its own team, owner, schedule, time zone and work days
- Per-command permissions, managers and a control center (`/admin`)
- Silent messages and "clean chat" (commands and replies are removed automatically)

## Using the bot

1. Add the bot to your group. **You become its owner there.**
2. Add your team: `/add Full Name @username` (one person per command).
3. Optional: `/settime 09:00`, `/settimezone Asia/Tashkent`, `/setdays mon-fri`.
4. Make the bot a group admin with "Delete messages" so clean chat works.
5. Send `/admin` to the bot in a private chat to manage permissions,
   managers and settings.

### Commands (defaults; the owner can change who may use each one)

| Who | Commands |
|---|---|
| Everyone | `/today`, `/schedule`, `/list`, `/help` |
| Managers | `/skip`, `/setturn @user`, `/swap @a @b`, `/add Name @user`, `/remove @user`, `/away @user`, `/back @user`, `/pause`, `/resume`, `/settime HH:MM` |
| Owner | `/settimezone Area/City`, `/setdays mon-fri`, `/admin`, `/addmanager @user`, `/removemanager @user` |

## Development

You'll need Node.js 22.13 or newer. There are no packages to install.

```bash
npm test
```

Every push to `main` is tested and deployed to Cloudflare automatically
(see `.github/workflows/deploy.yml`). After a deploy that changes Telegram
settings or menus, open `https://<worker-url>/init` once.

See **[CLAUDE.md](CLAUDE.md)** for architecture, decisions and conventions.

## One-time setup (already done for production)

1. **Cloudflare:** create a free account, a Worker named `duty-bot` and a D1
   database `duty-bot-db`. Put the database id in `wrangler.toml`.
2. **Bot token:** in the Worker, go to Settings → Variables and Secrets and add
   the secret `BOT_TOKEN` (from @BotFather).
3. **GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`: create it in Cloudflare → My Profile → API Tokens
     → "Edit Cloudflare Workers" template. Add the permission
     *Account → D1 → Edit* as well.
   - `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers & Pages overview page.
4. Push to `main`, then open `https://<worker-url>/init` once.
