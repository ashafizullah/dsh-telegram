<div align="center">

<h1>dsh-telegram</h1>

<p><strong>Talk to your agent from Telegram — and actually answer it when it asks something.</strong></p>

<p>
  <a href="https://github.com/ashafizullah/dsh-telegram/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ashafizullah/dsh-telegram/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@ashafizullah/dsh-telegram"><img alt="npm" src="https://img.shields.io/npm/v/%40ashafizullah/dsh-telegram?logo=npm&logoColor=white&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40ashafizullah/dsh-telegram?color=3da639"></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/node/v/%40ashafizullah/dsh-telegram?logo=node.js&logoColor=white&color=5fa04e"></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Bot API" src="https://img.shields.io/badge/Bot%20API-10.1%2B-2ca5e0?logo=telegram&logoColor=white"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4d6bfe"></a>
</p>

<p><strong>English</strong> · <a href="README.id.md">Bahasa Indonesia</a> · <a href="README.zh.md">中文</a></p>

</div>

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

## Requirements

- DeepSeek Harness with a profile you can add plugins to
- **Bot API 10.1 or later**, for `sendRichMessage` and `sendRichMessageDraft`
- Node 22 or later

There is no HTML fallback. Telegram's rich markdown parser is forgiving — an
unterminated code fence or a line of stray markers is accepted rather than
rejected — so a mid-stream frame does not need one.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @ashafizullah/dsh-telegram
```

Or from a checkout, to develop against it:

```bash
git clone https://github.com/ashafizullah/dsh-telegram.git
cd dsh-telegram
pnpm install && pnpm build

npx @deepseek-ai/dsh plugin --profile web add -w "$(pwd)"
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

The code is also written to `$DSH_HOME/dsh-telegram/claim-code.txt`, owner-only,
because several profiles compose no console sink at all and a code nobody can
read makes the bot permanently unusable.

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
| `/cd [path]` | Show or change the working directory |
| `/status` | Session id, working directory, and whether it is loaded |
| `/stop` | Cancel whatever the agent is doing right now |
| `/whoami` | Your Telegram user id |

### Where the agent works

`/cd` on its own says where the conversation is; `/cd ~/projects/app` moves it.
Absolute paths, `~`, and paths relative to where the conversation already is all
work, and a pasted path keeps its quotes off.

Moving starts a fresh conversation, and the bot says so. That is not a shortcut:
the sandbox derives its writable root from the session's working directory, and
that root is fixed when the session opens — so a directory change is a new
session by construction. The choice is remembered per chat and survives both
`/new` and a restart, which is why it is kept apart from the session binding
that `/new` discards.

A directory that does not exist, one that turns out to be a file, and one that
cannot be read are three different mistakes and get three different sentences.
Each leaves the conversation exactly where it was.

They are published to Telegram on every connection, so typing `/` in the chat
offers the list with descriptions. `/claim` drops off it once the bot has an
owner — it is the one command that stops working the moment it succeeds.

Anything else you type is a prompt for the agent.

## What you can send

| You send | What the agent gets |
| --- | --- |
| Text | The prompt |
| A photo, or an image sent as a file | What the vision model reads in it, and your caption |
| A text file — a log, a stack trace, source | Its contents in the prompt, truncated if very long |
| A voice note, audio, or video | A note saying it could not be read |

Images go through the harness attachment seam, which accepts PNG, JPEG, WebP
and GIF. Everything else it explicitly defers, so this plugin says so rather
than accepting the message and quietly dropping what it carried.

The seam also refuses an image whose longest side is over `maxImageDimension`,
2000 pixels by default — and every full-height phone screenshot is over it:
1179×2556 on an iPhone, 1080×2400 on most Android. Telegram sends a photo at
several rendered sizes, so the largest one that fits is chosen rather than the
largest one there is, and the seam's published limits are read from the store
itself so there is no second copy of the number to drift. If the seam refuses a
size anyway, the next smaller one is tried; when a photo sent uncompressed
leaves nothing to step down to, the refusal names the limit and says that
sending it as a photo would let Telegram offer a smaller copy.

A file that is too large, or that fails to download, becomes a note in the
prompt explaining why — your caption still reaches the agent either way.

### A model has to be able to look

A model that declares no image input rejects the whole request, so an image is
checked against `inputModalities` before it is sent. **No DeepSeek model
accepts images** — `deepseek-v4-flash` and `deepseek-v4-pro` are both text-only
— so out of the box a screenshot is declined with a sentence naming what would
work, and your caption still reaches the agent.

**Settings → Telegram → Attachments** offers a dropdown of the models already
configured in Settings → Models. Pick one and images become readable.

The picture never enters your conversation. It goes to a throwaway session on
that model, which is asked to transcribe every piece of text in it and describe
what it is; the reply comes back as ordinary text and *that* is what your
conversation receives, under your own caption. The session is disposed either
way — it exists for one turn.

The indirection is the point. A provider checks the entire request history for
images, so an image left in a conversation binds it to a model that can see for
as long as it lives: one screenshot and every later turn — however plain its own
text — has to run there too, away from the model you chose and the tools
configured around it. Reading it elsewhere keeps the history free of images, so
the conversation stays where it was, keeps its tools, and never gets stuck.

With no vision model configured nothing reaches this path at all: the image is
declined before it is even downloaded, with a sentence naming the models that
would have worked, and your caption still reaches the agent.

If a reading is attempted and fails — the model unreachable, the turn timing out
after two minutes — the picture goes through as it is and the conversation moves
onto the vision model instead, durably, until `/new`. That is the fallback
rather than the design, and the prompt says which happened.

The catalog the browser can read carries no modality information, so the
dropdown cannot mark which models accept images. The host checks that when an
image is actually sent, which is the one place the answer is certain. Vision
models reach the harness through a provider that carries them, such as an
OpenAI-compatible route added in Settings → Models, whose model entry declares
`input: [text, image]`.

### When a conversation gets stuck

A turn can fail in a way no retry clears — most often that one: an earlier
message carries content the current model will not take, and nothing typed next
will change it. The bot recognises those, says what failed, and offers a button
that starts a fresh conversation. Asking the user to remember `/new` would be
asking them to diagnose the plugin.

Failures that may pass on their own are reported without a button, because
retrying really is the right thing to do with them.

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
| `cwd` | harness cwd | Directory a conversation starts in until `/cd` moves it |
| `streaming.enabled` | `true` | Show the answer as it is written |
| `streaming.throttleMs` | `1200` | Minimum gap between streamed frames |
| `streaming.placeholder` | `…` | Body shown under a tool-activity line before any text arrives |
| `timeoutMs` | `30000` | Per-request Bot API timeout |
| `longPollSeconds` | `25` | How long Telegram holds an empty poll open |
| `media.enabled` | `true` | Read images and text files the user sends |
| `media.maxBytes` | `20 MB` | Refuse anything larger; Telegram caps bot downloads there |
| `media.maxTextChars` | `60000` | Truncate an inlined text file to this many characters |
| `media.visionModel` | `""` | `provider/model` that reads images in a session of its own; empty sends the image to the conversation itself. Picked from a dropdown on the settings page |
| `reconnect.baseDelayMs` | `1000` | Delay before the first reconnect attempt |
| `reconnect.maxDelayMs` | `30000` | Longest delay between reconnect attempts |

## Diagnostics

`ctx.logger` reaches whatever sink the deployment composed, and several profiles
compose none — so a plugin that only logs its failures is silent about them.
This one also writes its state to `$DSH_HOME/dsh-telegram/status.json` on every
transition:

```json
{ "state": "connected", "bot": "your_bot", "updatedAt": "..." }
```

`connecting`, `connected`, `idle` with a reason, `failed` with a reason. The bot
token never appears in it.

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
                                │           │
                                │           └──► VisionExtractor ──► a throwaway
                                │                                    session
                                ├──► MediaCollector ──► ctx.attachments
                                ├──► TelegramQuestionProvider ──► ctx.userQuestions
                                └──► TelegramApprovalAnswerer ──► approval/request

ctx.on('session/event') ──┬──► VisionExtractor   (its own reading sessions)
                          └──► TurnBridge ──► RichReplyStream ──► sendRichMessage

TypingIndicator          (held by the router and the bridge until a reply shows)
```

### How a reply is streamed

Telegram offers two mechanisms, and they are not interchangeable:

- **Private chats** use `sendRichMessageDraft` — an ephemeral preview that
  animates between frames sharing a draft id. It expires 30 seconds after its
  last frame, so a heartbeat re-sends the current text during a long tool call;
  otherwise the preview would vanish and the bot would look dead. A draft is
  never persisted, so the turn ends with a real `sendRichMessage`.
- **Groups have no draft API.** There the finished reply is simply sent when it
  is ready.

Both end with one permanent rich message.

### Nothing is posted until there is something to say

Telegram's own typing indicator carries the wait, and the reply appears only
once it has content — the first words, or the name of a tool the agent reached
for. An ellipsis posted the moment a turn opens tells the user what they
already know, and in a group it is a permanent message telling them.

The indicator is held rather than sent. `sendChatAction` lapses after five
seconds, which is shorter than almost everything worth waiting for here —
downloading a file, reading an image on a vision model, a turn queued behind
the last one, a minute inside a tool call — so one call reads as a bot that
started and died. Holds are counted per conversation and re-sent inside their
own expiry, so the router's hold while it reads an attachment and the bridge's
hold over the turn that follows overlap cleanly, and typing stops when the last
of them lets go. A ten-minute backstop covers a release that never arrives.

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
pnpm test          # 592 tests
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

## Known limitations

- **Groups have no gating.** In a group the bot answers every message from an
  allowlisted user — no mention or reply required.
- **Reasoning effort is not carried.** Only provider and model reach a Telegram
  session; an effort chosen in Settings → Models does not.
- **One directory per conversation.** `/cd` moves a conversation, but a
  session cannot be moved: the change starts a fresh one.
- **No voice, audio or video.** The harness attachment seam takes images only.

## License

MIT
