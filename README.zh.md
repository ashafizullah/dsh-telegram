<div align="center">

<h1>dsh-telegram</h1>

<p><strong>在 Telegram 上与你的 Agent 对话——并且在它提问时，真的能够回答。</strong></p>

<p>
  <a href="https://github.com/ashafizullah/dsh-telegram/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ashafizullah/dsh-telegram/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@ashafizullah/dsh-telegram"><img alt="npm" src="https://img.shields.io/npm/v/%40ashafizullah/dsh-telegram?logo=npm&logoColor=white&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40ashafizullah/dsh-telegram?color=3da639"></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/node/v/%40ashafizullah/dsh-telegram?logo=node.js&logoColor=white&color=5fa04e"></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Bot API" src="https://img.shields.io/badge/Bot%20API-10.1%2B-2ca5e0?logo=telegram&logoColor=white"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4d6bfe"></a>
</p>

<p><a href="README.md">English</a> · <a href="README.id.md">Bahasa Indonesia</a> · <strong>中文</strong></p>

</div>

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Telegram 前端。

在手机上与你的 Agent 对话——并且在它提问时，真的能够*回答*。

## 为什么需要它

用聊天软件驱动 Agent，会在两个具体的地方卡住，这个插件就是为了解决它们。

**Agent 写的是 markdown，而 Telegram 收到的是原文。** 模型的回答里有
`**粗体**`、标题、表格、任务清单和代码块。以纯文本发送时，这些全都变成了字面
上的星号和竖线。

从 Bot API 10.1 起，Telegram 自己会解析 markdown，因此本插件通过
`sendRichMessage` 几乎原样转发 Agent 的回复——表格显示为表格，清单显示为清单
——同时消息上限也从 4096 提升到 32768 个字符。

**Agent 会提问，却没有地方回答。** 当 Agent 调用 `ask_user_question`，或某个工
具需要你的许可时，harness 会阻塞并等待某个 UI 作答。而这件事以前只有浏览器能
做。完全发生在 Telegram 里的对话，会在第一个提问处停住，且无从解开。本插件把自
己注册为那个 UI，于是提问与授权都以按钮的形式出现在聊天里。

## 前置要求

- 一个可以添加插件的 DeepSeek Harness profile
- **Bot API 10.1 或更高版本**，用于 `sendRichMessage` 与 `sendRichMessageDraft`
- Node 22 或更高版本

没有 HTML 回退路径。Telegram 的 rich markdown 解析器是宽容的——未闭合的代码围栏
或一行散乱的标记都会被接受而非拒绝——所以流式过程中的中间帧并不需要回退。

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @ashafizullah/dsh-telegram
```

或者从源码检出，以便在其之上开发：

```bash
git clone https://github.com/ashafizullah/dsh-telegram.git
cd dsh-telegram
pnpm install && pnpm build

npx @deepseek-ai/dsh plugin --profile web add -w "$(pwd)"
```

然后给它一个机器人 Token。用 [@BotFather](https://t.me/BotFather) 创建机器人，
并把 Token 存放在凭据引用之下——永远不要写进配置文件：

```bash
npx @deepseek-ai/dsh credentials set TELEGRAM_BOT_TOKEN
```

启动 profile，控制台会打印一个认领码：

```
[dsh-telegram] this bot has no owner yet. Message @your_bot with:

    /claim 3f9a2b1c
```

把它发给你的机器人，它就归你了。在此之前，它不回应任何人。

该认领码同时会以仅属主可读的权限写入
`$DSH_HOME/dsh-telegram/claim-code.txt`，因为有些 profile 根本没有组合任何控制
台输出，而一个没人能读到的认领码会让机器人永远无法使用。

## 访问控制

任何知道句柄的人都能找到一个 Telegram 机器人，而它背后的 Agent 能在你的机器上
执行 shell 命令。因此默认是关闭的。

- **认领流程**（默认）：第一个发送控制台认领码的人成为属主。所有权是持久且一次
  性的——即使拿着正确的码，后来的认领也会被拒绝，所以事后泄露的码毫无用处。
- **允许名单**：把 `allowFrom` 设为一组 Telegram 用户 ID，即可完全跳过认领。用
  `/whoami` 查看自己的 ID。

认领码每次重启都会更换，且从不经由 Telegram 发送。

访问检查先于其它一切进行，因此未经授权的文本不会到达 Agent——连命令也不会。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/start` | 这个机器人是什么，以及你是否可以使用它 |
| `/help` | 列出所有命令 |
| `/claim <码>` | 认领一个尚未被认领的机器人 |
| `/new` | 开始新对话，忘掉当前这一段 |
| `/status` | 会话 ID、工作目录，以及是否已加载 |
| `/stop` | 取消 Agent 当前正在做的事 |
| `/whoami` | 你的 Telegram 用户 ID |

每次连接时这份列表都会注册到 Telegram，所以在聊天里输入 `/` 就会看到命令提示和
各自的说明。机器人一旦有了主人，`/claim` 就会从列表里消失——它是唯一一个成功之后
便不再有用的命令。

除此之外你输入的任何内容，都会作为提示词交给 Agent。

## 你可以发送什么

| 你发送 | Agent 收到 |
| --- | --- |
| 文本 | 提示词本身 |
| 照片，或以文件形式发送的图片 | 视觉模型读出的内容，以及你的说明文字 |
| 文本文件——日志、堆栈、源码 | 其内容进入提示词，过长时会被截断 |
| 语音、音频或视频 | 一句说明：无法读取 |

图片经由 harness 的附件接缝，它接受 PNG、JPEG、WebP 和 GIF。其余类型被官方明确
搁置，因此本插件会直言相告，而不是收下消息再悄悄丢掉其中的内容。

该接缝还会拒绝最长边超过 `maxImageDimension`（默认 2000 像素）的图片——而**每一张**
满屏的手机截图都超过它：iPhone 是 1179×2556，多数 Android 是 1080×2400。Telegram
会为一张照片渲染多个尺寸，因此这里选的是**放得下**的最大尺寸，而不是现有的最大
尺寸；限制值直接从 store 本身读取，不再另存一份会走样的数字。若接缝仍然拒绝，就
退到下一个更小的尺寸。至于以文件形式发送的图片——只有一个尺寸，无处可退——拒绝
信息会说明限制是多少，并提示改用照片方式发送，让 Telegram 提供较小的副本。

文件过大或下载失败时，会变成提示词里的一句说明——无论如何，你的说明文字仍会到达
Agent。

### 模型必须看得见

不声明图片输入的模型会拒绝**整个**请求，因此图片在发送前会对照
`inputModalities` 做检查。**没有任何 DeepSeek 模型接受图片**——
`deepseek-v4-flash` 与 `deepseek-v4-pro` 都是纯文本——所以开箱即用的情况下，截
图会被婉拒，并附上一句说明什么才可行，而你的说明文字仍会到达 Agent。

**设置 → Telegram → 附件** 提供一个下拉框，列出你已在 设置 → Models 中配置好的
模型。选一个，图片就能被读取了。

图片本身从不进入你的对话。它会被发到该模型上的一个一次性会话，被要求转写其中的
每一处文字，并简要描述这是什么；回答以普通文本返回，**那才是**你的对话所收到的
内容，就放在你自己的说明文字下面。那个会话随后即被销毁——它只活一个回合。

这一层间接正是关键。供应方会检查整个请求历史中的图片，所以留在对话里的一张图片
会把这段对话终身绑定到一个看得见图片的模型上：一张截图之后，后续每一个回合——
无论其文字多么普通——都得跟着跑到那里，远离你选定的模型和围绕它配置的工具。把
图片放到别处去读，历史中就始终没有图片，对话因而留在原处、保有工具，也永远不会
卡住。

如果根本没有配置视觉模型，这条路径压根不会被走到：图片在下载之前就被谢绝，并附上
一句说明哪些模型本可胜任，而你的说明文字仍会到达 Agent。

如果读取已经尝试但失败了——模型无法连接，或该回合在两分钟后超时——图片就按原样
发出，改为让对话迁移到视觉模型上，并持久生效，直到 `/new`。那是退路而非设计，
提示词里会说明发生了哪一种情况。

浏览器能读到的模型目录不携带模态信息，所以下拉框无法标出哪些模型接受图片。这项
检查交由 host 在图片真正发送时进行，那是唯一能给出确定答案的地方。视觉模型通过
承载它们的供应方进入 harness，例如在 设置 → Models 中添加的
OpenAI-compatible 路由，其模型条目声明了 `input: [text, image]`。

### 当对话卡住时

有一类失败重试永远无法解决——最常见的正是上面那种：早先的某条消息携带了当前模型
不接受的内容，而你接下来输入什么都无济于事。机器人会识别这类失败，说明失败原
因，并给出一个开启新对话的按钮。让用户去记住 `/new`，等于让他们替插件做诊断。

可能自行恢复的失败则不带按钮上报，因为对那些失败来说，重试确实是正确的做法。

## 配置

在 harness 的网页界面中打开 **设置 → Telegram**。该页面直接写入设置文档——没有
保存按钮，因为 host 通过重新连接来应用已提交的更改，而一个暂存改动的表单会让页
面和正在运行的机器人对"当前配置是什么"产生分歧。

机器人 Token 是例外。它是机密，因此从不经由设置通道来回传输：页面只知道是否已
存有 Token，通过 credentials 域写入它，并且对于环境变量已经提供的引用拒绝提供编
辑——在那里写入会看似成功，而解析仍旧返回环境变量中的值。

页面上的每一项，同样可以在 profile patch 中设置，供以文件方式配置的部署使用。

## 配置项

每个字段都有可用的默认值；配置为空也能运行。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 连接是否随 harness 一同启动 |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | 存放 Token 的凭据引用名 |
| `baseUrl` | `https://api.telegram.org` | Bot API 源站；仅在使用代理时修改 |
| `allowFrom` | `[]` | 允许的用户 ID；留空则启用认领流程 |
| `cwd` | harness 的 cwd | 新对话的工作目录 |
| `streaming.enabled` | `true` | 边生成边显示回答 |
| `streaming.throttleMs` | `1200` | 两帧之间的最小间隔 |
| `streaming.placeholder` | `…` | 在有正文之前，工具行下方显示的内容 |
| `timeoutMs` | `30000` | 单次 Bot API 请求的超时时间 |
| `longPollSeconds` | `25` | Telegram 保持空轮询打开的时长 |
| `media.enabled` | `true` | 读取用户发送的图片和文本文件 |
| `media.maxBytes` | `20 MB` | 超过则拒绝；Telegram 的机器人下载上限即在此 |
| `media.maxTextChars` | `60000` | 内联文本文件截断到此字符数 |
| `media.visionModel` | `""` | 在独立会话中读取图片的 `provider/model`；留空则把图片直接发给对话本身 |
| `reconnect.baseDelayMs` | `1000` | 第一次重连前的延迟 |
| `reconnect.maxDelayMs` | `30000` | 重连之间的最长延迟 |

## 诊断

`ctx.logger` 写往部署所组合的任何输出端，而有些 profile 一个都没有组合——因此一
个只把失败写进日志的插件，实际上是沉默的。本插件还会在每次状态变化时把自身状态
写入 `$DSH_HOME/dsh-telegram/status.json`：

```json
{ "state": "connected", "bot": "your_bot", "updatedAt": "..." }
```

`connecting`、`connected`、带原因的 `idle`、带原因的 `failed`。机器人 Token 绝不
会出现在其中。

## 与网页界面共存

harness 只允许**一个** user-questions provider，而在同时运行网页应用的 profile
中，浏览器已经占用了它。本插件接管该位置，并把浏览器的 provider 保留为回退：属
于浏览器会话的提问会被原样转交回去，属于 Telegram 对话的提问则变成聊天里的按
钮。卸载本插件会把先前的安排原样恢复。

授权本身是可组合的——harness 以 waterfall 方式运行它们——因此本插件只为自己的会
话作答，其余一律向后传递。

## 各部分如何衔接

```
Telegram Bot API
      │  长轮询：message + callback_query
      ▼
UpdatePoller ──► UpdateRouter ──┬──► SessionRunner ──► ctx.agents
                                │           │
                                │           └──► VisionExtractor ──► 一次性会话
                                ├──► MediaCollector ──► ctx.attachments
                                ├──► TelegramQuestionProvider ──► ctx.userQuestions
                                └──► TelegramApprovalAnswerer ──► approval/request

ctx.on('session/event') ──┬──► VisionExtractor   （它自己的读取会话）
                          └──► TurnBridge ──► RichReplyStream ──► sendRichMessage

TypingIndicator          （路由器与桥接持有，直到回复出现）
```

### 回复是如何流式呈现的

Telegram 提供了两种机制，二者不可互换：

- **私聊**使用 `sendRichMessageDraft`——一个临时预览，共享同一 draft id 的各帧之
  间会有动画过渡。它在最后一帧之后 30 秒过期，因此在漫长的工具调用期间，会有一
  个心跳重发当前文本；否则预览会消失，机器人看上去就像死了。草稿从不持久化，所
  以一个回合以真正的 `sendRichMessage` 结束。
- **群组没有草稿 API。** 那里就在回复写完时直接发送。

两者最终都归于一条持久的 rich message。

### 在有话可说之前，什么都不发

等待期交给 Telegram 自己的 “正在输入…” 指示，回复只在真正有内容时才出现——第一批
文字，或者 Agent 调用的工具名。回合一开就发出去的省略号，只是在告诉用户他们已经
知道的事；在群里，它还是一条永久留存的消息。

指示是**被持有**的，而不是发一次。`sendChatAction` 五秒即失效，比这里几乎所有值得
等待的事都短——下载文件、在视觉模型上读取图片、排在上一个回合后面、或在某个工具
调用里待上一分钟——所以单次调用读起来就像机器人启动后立刻死了。持有按会话计数，
并在其自身有效期内重发，因此路由器读取附件时的持有与桥接随后那个回合的持有能干净
地重叠，只有最后一个释放时才停止输入。另有十分钟的兜底，以防某次释放永远不来。

在 Agent 工作期间，正在运行的工具会以 `<tg-thinking>` 块显示在回复上方：

```
▸ bash: npm test

目前我发现的是……
```

Telegram 只在草稿中接受该块，别处一概不接受，这与它的生命周期恰好吻合——回合被
持久化时它就消失，于是最终回复承载的是答案，而不是产生答案的脚手架。它只有被截
断的一行：一次工具调用的参数可能长达整个文件，而这里的目的是知道 Agent 还活着，
不是阅读一份记录。

## 开发

```bash
pnpm install
pnpm test          # 561 个测试
pnpm test -- --coverage
pnpm typecheck     # host 与 browser 两半
pnpm build         # host 用 tsc，浏览器包用 esbuild
```

每个模块都能脱离 harness 运行，这正是测试套件跑得快的原因：插件入口是对着 Bot
API 的真实 HTTP 桩来执行的，而浏览器包的物化方式与 shell 完全一致。

### 浏览器那一半

`build.client.mjs` 把 esbuild 产出的 CJS 包裹进 shell 的惰性 CJS 工厂信封
(`window.__ModuleLoader__.load({ id, factory })`)。该信封是复现出来的而非引入
的：harness 的 `clientBundle` 预设并未发布，其自身文档也把这一点列为对仓库之外
插件的已知限制。

因此这里是本插件唯一与内部格式耦合的地方，而 `test/client-bundle.test.ts` 将其
钉住——该测试会执行构建、用桩 `require` 物化工厂，并检查 `apply` 是否占据了它的
设置席位。若某个 harness 版本改变了该格式，失败会在那里以明确的名字出现，而不是
表现为一个空白的设置页。

React 与 shell 自身的包被标记为 external；打包第二份 React 会在页面挂载的一瞬间
破坏所有 hook。

## 已知限制

- **群组没有触发限制。** 在群里，机器人会回应允许名单内用户的每一条消息——无需
  @提及，也无需回复。
- **推理强度未被传递。** 只有 provider 和 model 会到达 Telegram 会话；在
  设置 → Models 中选择的推理强度不会。
- **只有一个工作目录。** 所有对话都从同一个 `cwd` 开始。
- **暂不支持语音、音频或视频。** harness 的附件接缝只接受图片。

## 许可证

MIT
