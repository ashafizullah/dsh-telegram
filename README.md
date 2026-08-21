# dsh-telegram

A Telegram front end for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Talk to your agent from your phone — and actually *answer* it when it asks something.

## Why this exists

Running an agent from a chat app breaks down at two specific points, and this
plugin is built around fixing them.

**The agent writes markdown; Telegram was getting it raw.** Models answer with
`**bold**`, headings, tables, task lists and fenced code. Sent as plain text,
all of that arrives as literal asterisks and pipes.

Since Bot API 10.1 Telegram parses markdown itself, so this plugin forwards the
agent's reply almost verbatim through `sendRichMessage` — tables render as
tables, checklists as checklists — and the message cap rises from 4096 to
32768 characters with it.

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

## What you can send

| You send | What the agent gets |
| --- | --- |
| Text | The prompt |
| A photo, or an image sent as a file | The image itself, and your caption |
| A text file — a log, a stack trace, source | Its contents in the prompt, truncated if very long |
| A voice note, audio, or video | A note saying it could not be read |

Images go through the harness attachment seam, which accepts PNG, JPEG, WebP
and GIF. Everything else it explicitly defers, so this plugin says so rather
than accepting the message and quietly dropping what it carried.

### A model has to be able to look

A model that declares no image input rejects the whole request, so an image is
checked against `inputModalities` before it is sent. **No DeepSeek model
accepts images** — `deepseek-v4-flash` and `deepseek-v4-pro` are both text-only
— so out of the box a screenshot is declined with a sentence naming what would
work, and your caption still reaches the agent.

**Settings → Telegram → Attachments** offers a dropdown of the models already
configured in Settings → Models. Pick one and a conversation that carries an
image runs there.

It applies to the whole conversation, not just the turn with the picture in it,
and that is not a preference — a provider checks the entire request history for
images, so one image makes every later turn fail on a model that cannot see,
however plain that turn's own text. The mark is durable, so a restart does not
reroute the conversation back into failing. `/new` clears it.

### When a conversation gets stuck

A turn can fail in a way no retry clears — most often that one: an earlier
message carries content the current model will not take, and nothing typed next
will change it. The bot recognises those, says what failed, and offers a button
that starts a fresh conversation. Asking the user to remember `/new` would be
asking them to diagnose the plugin.

Failures that may pass on their own are reported without a button, because
retrying really is the right thing to do with them.

The catalog the browser can read carries no modality information, so the
dropdown cannot mark which models accept images; the host checks that when an
image is actually sent, which is the one place the answer is certain. Vision
models reach the harness through a provider that carries them, such as an
OpenAI-compatible route added in Settings → Models.

A file that is too large, or that fails to download, becomes a note in the
prompt explaining why — your caption still reaches the agent either way.

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
| `streaming.enabled` | `true` | Show the answer as it is written |
| `streaming.throttleMs` | `1200` | Minimum gap between streamed frames |
| `streaming.placeholder` | `…` | Shown before any text arrives |
| `longPollSeconds` | `25` | How long Telegram holds an empty poll open |
| `media.enabled` | `true` | Read images and text files the user sends |
| `media.maxBytes` | `20 MB` | Refuse anything larger; Telegram caps bot downloads there |
| `media.maxTextChars` | `60000` | Truncate an inlined text file to this many characters |
| `media.visionModel` | `""` | `provider/model` for turns carrying an image; empty uses the conversation's model. Picked from a dropdown on the settings page |

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

ctx.on('session/event') ──► TurnBridge ──► RichReplyStream ──► sendRichMessage
```

### How a reply is streamed

Telegram offers two mechanisms, and they are not interchangeable:

- **Private chats** use `sendRichMessageDraft` — an ephemeral preview that
  animates between frames sharing a draft id. It expires 30 seconds after its
  last frame, so a heartbeat re-sends the current text during a long tool call;
  otherwise the preview would vanish and the bot would look dead. A draft is
  never persisted, so the turn ends with a real `sendRichMessage`.
- **Groups have no draft API.** There a placeholder is posted immediately and
  replaced with the finished reply, so the room still sees the bot working.

Both end with one permanent rich message.

While the agent works, the running tool is shown above the reply in a
`<tg-thinking>` block:

```
▸ bash: npm test

Here is what I found so far…
```

Telegram accepts that block in a draft and nowhere else, which matches its
lifetime exactly — it disappears when the turn is persisted, so the finished
reply carries the answer rather than the scaffolding that produced it. It is a
single clipped line: a tool call's arguments can be an entire file, and the
point is knowing the agent is alive, not reading a transcript.

Access is checked before anything else, so no unauthorised text reaches the
agent — not even a command.

## Development

```bash
pnpm install
pnpm test          # 451 tests
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

### Requirements

Bot API **10.1 or later**, for `sendRichMessage` and `sendRichMessageDraft`.
There is no HTML fallback: Telegram's rich markdown parser is forgiving — an
unterminated code fence or a line of stray markers is accepted rather than
rejected — so a mid-stream frame does not need one.

## License

MIT
