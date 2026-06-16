# Telegram AI Bot

A simple Telegram bot that replies with Groq.

It also includes a safe task/connector layer:

- `/tool` runs safe read-only tools.
- `/act` queues GitHub, Cloudflare, and Railway write tools.
- `/task` creates a plan, but does not execute anything.
- `/do` executes safe built-in actions after approval.
- `/remember` saves important facts for the current chat.
- `/memory` shows saved memory.
- `/history` shows recent chat context.
- Auto-memory saves obvious project facts from normal messages.
- `/todo`, `/todos`, `/done`, `/undone`, and `/delete` manage chat tasks.
- `/run connector_name task` queues work for an allowed external server.
- `/approve action_id` is required before the bot calls an external server or changes an external account.
- connectors must be explicitly allowlisted in `.env`.

## Setup

1. Copy `.env.example` to `.env`.
2. Add your BotFather token:

```env
TELEGRAM_BOT_TOKEN=...
```

3. Add your Groq API key:

```env
GROQ_API_KEY=...
```

4. Run:

```bash
npm start
```

If `npm` is not available on your Mac, you can run the bot with the bundled Node runtime:

```bash
/Users/ainaz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node index.js
```

## Railway Deploy

Use these settings when creating the Railway service:

- Repository: `koldeybekova-tech/portfolio-website`
- Root directory: `telegram-ai-bot`
- Start command: `node index.js`

Add these variables in Railway:

```env
TELEGRAM_BOT_TOKEN=...
GROQ_API_KEY=...
GROQ_MODEL=llama-3.1-8b-instant
BOT_NAME=Symbat AI
SYSTEM_PROMPT=You are a helpful, warm Telegram assistant. Answer clearly and briefly.
AUTO_MEMORY=true
CONNECTORS_JSON=[]
```

Do not upload `.env` to GitHub. It is ignored by `.gitignore`.

Optional write-action variables:

```env
GITHUB_TOKEN=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
RAILWAY_DEPLOY_HOOK_URL=...
```

Add these in Railway Variables only when you need the matching tool. The bot will still require `/approve ACTION_ID` before using them.

## Group Chat

In BotFather:

```text
/mybots -> your bot -> Bot Settings -> Group Privacy -> Turn off
```

Then add the bot to your group chat.

In a group, the bot answers when:

- you tag it, for example `@your_bot hello`
- or you write `/ask your question`
- or you start the message with `бот,`

In private chat, it answers every message.

## Natural Language

You do not always need `/` commands. In private chat, the bot understands normal messages. In group chats, tag the bot or start with `бот,`.

Examples:

```text
запомни, что мой домен bysymbat.com
добавь задачу проверить DNS
покажи задачи
удали задачу TASK_ID
проверь домен bysymbat.com
проверь сайт https://bysymbat.com
проверь github koldeybekova-tech/portfolio-website
переведи на английский: сайт готов
сделай чеклист запуск портфолио
какие идеи для портфолио?
```

Natural execution phrases such as `переведи`, `сделай чеклист`, or `напиши текст` still create an approval step before the bot runs the action.

For the latest pending action in the same chat, you can approve or reject without copying the id:

```text
/approve last
да, подтверждаю
подтверждаю
/reject last
отмени действие
```

If there is more than one pending action, the bot will ask you to choose the exact id.

## Commands

```text
/help
/whoami
/ask explain something
/remember my portfolio domain is bysymbat.com
/memory
/history
/forget MEMORY_ID
/todo update the portfolio hero video
/todos
/done TASK_ID
/undone TASK_ID
/delete TASK_ID
/task plan this work safely
/tools
/tool dns bysymbat.com
/tool website https://bysymbat.com
/tool github koldeybekova-tech/portfolio-website
/actions
/act github-issue koldeybekova-tech/portfolio-website | Title | Body
/act cloudflare-cname bysymbat.com | www | target.example.com | false
/act cloudflare-a bysymbat.com | @ | 76.76.21.21 | false
/act railway-deploy redeploy bot
/do draft write a polite reply
/do summarize pasted long text
/do translate translate this to English
/do checklist prepare launch steps
/do note remember this for later
/connectors
/run connector_name do this task
/approve ACTION_ID
/approve last
/reject ACTION_ID
/reject last
```

## Built-in Tools

These tools only read public information and do not change external accounts:

- `dns` - checks public DNS records through DNS-over-HTTPS
- `website` - checks HTTP status, final URL, response time, and page title
- `github` - checks a public GitHub repo and latest commit

Useful examples:

```text
/tool dns bysymbat.com
/tool website https://bysymbat.com
/tool github koldeybekova-tech/portfolio-website
```

Natural language examples:

```text
проверь домен bysymbat.com
проверь сайт https://bysymbat.com
проверь github koldeybekova-tech/portfolio-website
```

## Approved Write Tools

These tools can change external accounts, so they always create a pending action first. Nothing is changed until an allowed user approves:

```text
/approve ACTION_ID
```

For the newest pending action in the same chat, you can also use:

```text
/approve last
да, подтверждаю
```

Available tools:

- `github-issue` - creates a GitHub issue in a repo
- `cloudflare-cname` - creates or updates a Cloudflare CNAME record
- `cloudflare-a` - creates or updates a Cloudflare A record
- `railway-deploy` - triggers a Railway deploy hook

Examples:

```text
/act github-issue koldeybekova-tech/portfolio-website | Domain setup | Connect bysymbat.com through Cloudflare
/act cloudflare-cname bysymbat.com | www | portfolio-production.up.railway.app | false
/act cloudflare-a bysymbat.com | @ | 76.76.21.21 | false
/act railway-deploy redeploy after changing variables
```

Required variables:

- `GITHUB_TOKEN` with access to create issues in the selected repo
- `CLOUDFLARE_API_TOKEN` with DNS edit access
- `CLOUDFLARE_ZONE_ID`, optional but recommended for the domain zone
- `RAILWAY_DEPLOY_HOOK_URL`, created in Railway service settings

Never send these secrets in normal chat messages. Put them in Railway Variables.

## Built-in Execution

The bot can execute these safe built-in actions:

- `draft` - writes a message, email, post, or other text
- `summarize` - summarizes long text
- `translate` - translates text
- `checklist` - turns a task into clear action items
- `note` - saves a local note in `data/notes.jsonl`

Every `/do` action creates a pending action first. It only runs after:

```text
/approve ACTION_ID
```

This keeps the bot useful without letting it silently do things.

## Memory

The bot stores memory locally in:

```text
data/memory.json
```

Recent chat context is stored in:

```text
data/history.jsonl
```

Tasks are stored in:

```text
data/tasks.json
```

Both files are ignored by git through `.gitignore`, so private chat context is not committed.

Useful commands:

```text
/remember remember that my portfolio is on GitHub
/memory
/history
/forget MEMORY_ID
/forget all
```

Auto-memory is enabled by default:

```env
AUTO_MEMORY=true
```

It tries to save only useful facts, such as project names, domains, GitHub links, preferences, and portfolio context. It skips messages that look like tokens, API keys, passwords, or secrets.

To turn auto-memory off:

```env
AUTO_MEMORY=false
```

## Tasks

Useful commands:

```text
/todo publish the portfolio on bysymbat.com
/todos
/done TASK_ID
/undone TASK_ID
/delete TASK_ID
```

Open tasks are also included as context when the bot answers.

## Safe Connectors

To let the bot call another server, add it to `.env`:

```env
CONNECTORS_JSON=[{"name":"nora","url":"https://example.com/telegram-task","token":"secret","requiresApproval":true}]
```

The bot will not call unknown URLs. It only calls named connectors from this allowlist.

To restrict approvals to specific Telegram accounts, first run `/whoami`, then add:

```env
APPROVER_USER_IDS=123456789
```

If `APPROVER_USER_IDS` is empty, only the person who requested an action can approve it.
