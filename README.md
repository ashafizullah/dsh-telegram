# dsh-telegram

A Telegram front end for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Talk to your agent from your phone — and actually *answer* it when it asks something.

## Why this exists

Running an agent from a chat app breaks down at two specific points, and this
plugin is built around fixing them.

**The agent writes markdown; Telegram was getting it raw.** Models answer with
`**bold**`, headings, bullet lists and fenced code. Sent as plain text, all of
that arrives as literal asterisks and backticks. This plugin renders replies to
Telegram HTML and sends them with `parse_mode`, so code blocks are code blocks
— including while the answer is still streaming in.

**The agent asks questions; there was nowhere to answer them.** When the agent
calls `ask_user_question`, or a tool needs your permission, the harness blocks
and waits for a UI to answer. Only the browser could. A conversation held
entirely in Telegram would stall on the first question with no way to clear it.
This plugin registers itself as that UI, so questions and approvals arrive as
buttons in the chat.

## Install

```bash
# from a checkout
pnpm build
npx @deepseek-ai/dsh plugin --profile web add -w /path/to/dsh-telegram
```

Then give it a bot token. Create a bot with [@BotFather](https://t.me/BotFather)
and store the token under the credential reference — never in a config file:

```bash
npx @deepseek-ai/dsh credentials set TELEGRAM_BOT_TOKEN
```

Start the profile. The console prints a claim code:

```
[dsh-telegram] this bot has no owner yet. Message @your_bot with:

    /claim 3f9a2b1c
```

Send that to your bot and it is yours. Until then it answers nobody.

## Access

A Telegram bot is reachable by anyone who knows its handle, and the agent behind
it can run shell commands on your machine. So the default is closed.

- **Claim flow** (default): the first person to send the console-printed code
  becomes the owner. Ownership is durable and single-shot — a later claim is
  refused even with the right code, so a leaked code grants nothing.
- **Allowlist**: set `allowFrom` to a list of Telegram user ids to skip claiming
  entirely. Use `/whoami` to find your id.

The claim code changes on every restart and is never sent over Telegram.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | What this bot is, and whether you may use it |
| `/help` | List the commands |
| `/claim <code>` | Take ownership of an unclaimed bot |
| `/new` | Start a fresh conversation, forgetting the current one |
| `/status` | Session id, working directory, and whether it is loaded |
| `/stop` | Cancel whatever the agent is doing right now |
| `/whoami` | Your Telegram user id |

Anything else you type is a prompt for the agent.

## Configuring it

Open **Settings → Telegram** in the harness web UI. The page writes straight to
the settings document — there is no Save button, because the host applies a
committed change by reconnecting, and a staged form would let the page and the
running bot disagree about what is configured.

The bot token is the exception. It is a secret, so it never rides the settings
wire in either direction: the page learns only whether one is stored, writes it
through the credentials domain, and refuses to offer an edit for a reference the
environment already supplies (a write there would look like it worked while
resolution kept returning the shadowing value).

Everything on the page is equally settable in a profile patch, for a deployment
that configures by file:

## Configuration

Every field has a working default; an empty config runs.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether the connection starts with the harness |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential reference holding the token |
| `baseUrl` | `https://api.telegram.org` | Bot API origin; change only for a proxy |
| `allowFrom` | `[]` | User ids allowed in; empty enables the claim flow |
| `cwd` | harness cwd | Working directory new conversations start in |
| `streaming.enabled` | `true` | Edit one message as the answer streams |
| `streaming.throttleMs` | `1200` | Minimum gap between edits |
| `streaming.placeholder` | `…` | Shown before any text arrives |
| `longPollSeconds` | `25` | How long Telegram holds an empty poll open |

## Living alongside the web UI

The harness allows exactly one user-questions provider, and in a profile that
also runs the web app the browser has already claimed it. This plugin takes the
slot over and keeps the browser's provider as a fallback: a question belonging
to a browser session is forwarded straight back to it, and one belonging to a
Telegram conversation becomes buttons in the chat. Unloading the plugin puts
the previous arrangement back exactly.

Approvals compose natively — the harness runs them as a waterfall — so this
plugin answers for its own sessions and passes every other one along.

## How it fits together

```
Telegram Bot API
      │  long poll: message + callback_query
      ▼
UpdatePoller ──► UpdateRouter ──┬──► SessionRunner ──► ctx.agents
                                │
                                ├──► TelegramQuestionProvider ──► ctx.userQuestions
                                └──► TelegramApprovalAnswerer ──► approval/request

ctx.on('session/event') ──► TurnBridge ──► ReplyStream ──► markdown → HTML → Telegram
```

Access is checked before anything else, so no unauthorised text reaches the
agent — not even a command.

## Development

```bash
pnpm install
pnpm test          # 323 tests
pnpm test -- --coverage
pnpm typecheck     # host and browser halves
pnpm build         # tsc for the host, esbuild for the browser bundle
```

Every module runs without a harness, which is what keeps the suite fast: the
plugin entry is exercised against a real HTTP stub of the Bot API, and the
browser bundle is materialized exactly as the shell materializes it.

### The browser half

`build.client.mjs` wraps an esbuild CJS bundle in the shell's lazy-CJS factory
envelope (`window.__ModuleLoader__.load({ id, factory })`). That envelope is
reproduced rather than imported: the harness's `clientBundle` preset is not
published, which its own documentation lists as a known limitation for plugins
shipped outside its repository. It is therefore the single place this plugin is
coupled to an internal format, and `test/client-bundle.test.ts` pins it — the
test runs the build, materializes the factory with a stub `require`, and checks
that `apply` claims its settings seat. A harness release that changes the format
fails there by name instead of showing up as a blank Settings page.

React and the shell's own packages are marked external; bundling a second React
would break every hook the moment the page mounted.

## License

MIT
