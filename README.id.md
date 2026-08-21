<div align="center">

<h1>dsh-telegram</h1>

<p><strong>Ajak bicara agent-mu dari Telegram — dan benar-benar bisa menjawabnya saat ia bertanya.</strong></p>

<p>
  <a href="https://github.com/ashafizullah/dsh-telegram/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ashafizullah/dsh-telegram/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@ashafizullah/dsh-telegram"><img alt="npm" src="https://img.shields.io/npm/v/%40ashafizullah/dsh-telegram?logo=npm&logoColor=white&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40ashafizullah/dsh-telegram?color=3da639"></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/node/v/%40ashafizullah/dsh-telegram?logo=node.js&logoColor=white&color=5fa04e"></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Bot API" src="https://img.shields.io/badge/Bot%20API-10.1%2B-2ca5e0?logo=telegram&logoColor=white"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4d6bfe"></a>
</p>

<p><a href="README.md">English</a> · <strong>Bahasa Indonesia</strong> · <a href="README.zh.md">中文</a></p>

</div>

Antarmuka Telegram untuk [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Ajak bicara agent-mu dari ponsel — dan benar-benar bisa *menjawab* saat ia bertanya.

## Kenapa ini ada

Menjalankan agent dari aplikasi chat mentok di dua titik, dan plugin ini
dibangun untuk membereskan keduanya.

**Agent menulis markdown; Telegram menerimanya mentah.** Model menjawab dengan
`**tebal**`, heading, tabel, checklist, dan blok kode. Dikirim sebagai teks
biasa, semua itu sampai sebagai tanda bintang dan garis tegak literal.

Sejak Bot API 10.1 Telegram mem-parse markdown sendiri, jadi plugin ini
meneruskan balasan agent hampir apa adanya lewat `sendRichMessage` — tabel
tampil sebagai tabel, checklist sebagai checklist — dan batas pesan naik dari
4096 ke 32768 karakter.

**Agent bertanya; tidak ada tempat untuk menjawabnya.** Saat agent memanggil
`ask_user_question`, atau sebuah tool butuh izinmu, harness berhenti dan
menunggu sebuah UI menjawab. Hanya browser yang bisa. Percakapan yang
seluruhnya di Telegram akan tersangkut di pertanyaan pertama tanpa jalan
keluar. Plugin ini mendaftarkan dirinya sebagai UI itu, jadi pertanyaan dan
permintaan izin datang sebagai tombol di chat.

## Kebutuhan

- DeepSeek Harness dengan profile yang bisa ditambahi plugin
- **Bot API 10.1 atau lebih baru**, untuk `sendRichMessage` dan `sendRichMessageDraft`
- Node 22 atau lebih baru

Tidak ada jalur cadangan HTML. Parser rich markdown Telegram pemaaf — code
fence yang belum ditutup atau baris berisi marker berantakan tetap diterima,
bukan ditolak — jadi frame di tengah stream tidak membutuhkannya.

## Pemasangan

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @ashafizullah/dsh-telegram
```

Atau dari checkout, kalau mau ikut mengembangkannya:

```bash
git clone https://github.com/ashafizullah/dsh-telegram.git
cd dsh-telegram
pnpm install && pnpm build

npx @deepseek-ai/dsh plugin --profile web add -w "$(pwd)"
```

Lalu beri token bot. Buat bot lewat [@BotFather](https://t.me/BotFather) dan
simpan tokennya di bawah referensi kredensial — jangan pernah di berkas config:

```bash
npx @deepseek-ai/dsh credentials set TELEGRAM_BOT_TOKEN
```

Jalankan profile-nya. Konsol akan mencetak kode klaim:

```
[dsh-telegram] this bot has no owner yet. Message @your_bot with:

    /claim 3f9a2b1c
```

Kirim itu ke bot-mu dan bot itu jadi milikmu. Sebelum itu, ia tidak menjawab
siapa pun.

Kodenya juga ditulis ke `$DSH_HOME/dsh-telegram/claim-code.txt` dengan izin
hanya-pemilik, karena beberapa profile tidak mengomposisi sink konsol sama
sekali — dan kode yang tak bisa dibaca membuat bot mustahil dipakai.

## Akses

Bot Telegram bisa dihubungi siapa pun yang tahu handle-nya, dan agent di
belakangnya bisa menjalankan perintah shell di mesinmu. Jadi bawaannya
tertutup.

- **Alur klaim** (bawaan): orang pertama yang mengirim kode dari konsol menjadi
  pemilik. Kepemilikan bersifat durable dan sekali saja — klaim berikutnya
  ditolak walau kodenya benar, jadi kode yang bocor tidak memberi apa pun.
- **Daftar izin**: isi `allowFrom` dengan daftar user ID Telegram untuk
  melewati proses klaim sepenuhnya. Pakai `/whoami` untuk melihat ID-mu.

Kode klaim berubah setiap restart dan tidak pernah dikirim lewat Telegram.

Akses diperiksa sebelum apa pun yang lain, jadi tidak ada teks tanpa izin yang
sampai ke agent — bahkan sebuah command sekalipun.

## Perintah

| Perintah | Fungsinya |
| --- | --- |
| `/start` | Bot ini apa, dan apakah kamu boleh memakainya |
| `/help` | Daftar perintah |
| `/claim <kode>` | Mengambil kepemilikan bot yang belum diklaim |
| `/new` | Mulai percakapan baru, melupakan yang sekarang |
| `/status` | ID sesi, working directory, dan apakah sedang dimuat |
| `/stop` | Batalkan apa pun yang sedang dikerjakan agent |
| `/whoami` | User ID Telegram-mu |

Apa pun selain itu diperlakukan sebagai prompt untuk agent.

## Yang bisa kamu kirim

| Kamu kirim | Yang diterima agent |
| --- | --- |
| Teks | Prompt-nya |
| Foto, atau gambar yang dikirim sebagai file | Isi gambar yang dibaca model vision, beserta caption-mu |
| Berkas teks — log, stack trace, source | Isinya dalam prompt, dipotong bila sangat panjang |
| Voice note, audio, atau video | Catatan bahwa itu tidak bisa dibaca |

Gambar melewati seam attachment harness, yang menerima PNG, JPEG, WebP, dan
GIF. Sisanya secara eksplisit ditunda, jadi plugin ini mengatakannya alih-alih
menerima pesan lalu diam-diam membuang isinya.

Seam itu juga menolak gambar yang sisi terpanjangnya melebihi
`maxImageDimension` — bawaannya 2000 piksel — dan **setiap** screenshot ponsel
setinggi layar melewatinya: 1179×2556 di iPhone, 1080×2400 di kebanyakan
Android. Telegram mengirim satu foto dalam beberapa ukuran, jadi yang dipilih
adalah ukuran terbesar yang **muat**, bukan yang terbesar yang ada; limitnya
dibaca langsung dari store-nya sendiri supaya tidak ada salinan angka yang bisa
melenceng. Kalau seam tetap menolak, ukuran berikutnya yang dicoba. Untuk
gambar yang dikirim sebagai berkas — hanya ada satu ukuran, tidak ada yang bisa
diturunkan — penolakannya menyebutkan limitnya dan menyarankan mengirimnya
sebagai foto supaya Telegram menyediakan salinan yang lebih kecil.

Berkas yang terlalu besar, atau gagal diunduh, menjadi catatan di prompt yang
menjelaskan sebabnya — caption-mu tetap sampai ke agent.

### Model harus bisa melihat

Model yang tidak mendeklarasikan input gambar akan menolak **seluruh** request,
jadi gambar diperiksa terhadap `inputModalities` sebelum dikirim. **Tidak ada
model DeepSeek yang menerima gambar** — `deepseek-v4-flash` dan
`deepseek-v4-pro` keduanya hanya teks — sehingga secara bawaan sebuah screenshot
ditolak dengan kalimat yang menyebutkan apa yang akan berhasil, dan caption-mu
tetap sampai ke agent.

**Settings → Telegram → Attachments** menyediakan dropdown berisi model yang
sudah kamu konfigurasi di Settings → Models. Pilih satu, dan gambar jadi bisa
dibaca.

Gambarnya sendiri tidak pernah masuk ke percakapanmu. Gambar itu dikirim ke
sesi sekali-pakai di model tersebut, yang diminta mentranskrip setiap teks di
dalamnya dan menjelaskan singkat gambar apa itu; jawabannya kembali sebagai teks
biasa, dan **itulah** yang diterima percakapanmu, di bawah caption-mu sendiri.
Sesi itu dibuang setelahnya — umurnya satu turn.

Perantaraan itulah intinya. Provider memeriksa seluruh riwayat request untuk
gambar, jadi gambar yang tertinggal di sebuah percakapan mengikat percakapan itu
ke model yang bisa melihat selamanya: satu screenshot, dan setiap turn
berikutnya — sepolos apa pun teksnya — ikut berjalan di sana, jauh dari model
yang kamu pilih dan tool yang dikonfigurasi di sekitarnya. Membacanya di tempat
lain membuat riwayat tetap bersih dari gambar, sehingga percakapan tetap di
tempatnya, tetap punya tool-nya, dan tidak pernah tersangkut.

Kalau tidak ada model vision yang dikonfigurasi, jalur ini tidak pernah
tersentuh sama sekali: gambarnya ditolak bahkan sebelum diunduh, dengan kalimat
yang menyebutkan model mana yang akan berhasil, dan caption-mu tetap sampai ke
agent.

Kalau pembacaan sudah dicoba lalu gagal — model tidak bisa dihubungi, atau
turn-nya habis waktu setelah dua menit — gambarnya dikirim apa adanya dan
percakapan yang pindah ke model vision, secara durable, sampai `/new`. Itu
cadangan, bukan rancangannya, dan prompt-nya menyebutkan mana yang terjadi.

Katalog yang bisa dibaca browser tidak membawa informasi modalitas, jadi
dropdown itu tidak bisa menandai model mana yang menerima gambar. Host yang
memeriksanya saat gambar benar-benar dikirim — satu-satunya tempat jawabannya
pasti. Model vision sampai ke harness lewat provider yang membawanya, misalnya
route OpenAI-compatible yang ditambahkan di Settings → Models, yang entri
model-nya mendeklarasikan `input: [text, image]`.

### Saat percakapan tersangkut

Sebuah turn bisa gagal dengan cara yang tidak bisa diperbaiki dengan mencoba
lagi — paling sering justru yang itu: pesan sebelumnya membawa konten yang tidak
diterima model saat ini, dan tidak ada yang kamu ketik berikutnya bisa
mengubahnya. Bot mengenali kasus semacam itu, mengatakan apa yang gagal, dan
menawarkan tombol untuk memulai percakapan baru. Meminta pengguna mengingat
`/new` sama saja meminta mereka mendiagnosis plugin ini.

Kegagalan yang mungkin sembuh sendiri dilaporkan tanpa tombol, karena untuk
yang itu mencoba lagi memang tindakan yang benar.

## Mengaturnya

Buka **Settings → Telegram** di UI web harness. Halaman itu menulis langsung ke
settings document — tidak ada tombol Save, karena host menerapkan perubahan
dengan menyambung ulang, dan form yang menahan draft akan membuat halaman dan
bot yang sedang jalan berbeda pendapat soal apa yang aktif.

Token bot adalah pengecualian. Ia rahasia, jadi tidak pernah melewati jalur
settings ke arah mana pun: halaman hanya tahu *apakah* ada token tersimpan,
menulisnya lewat domain credentials, dan menolak menawarkan pengeditan untuk
referensi yang sudah disediakan environment — menulis di sana akan terlihat
berhasil padahal resolusi tetap mengembalikan nilai environment.

Semua yang ada di halaman itu sama-sama bisa diatur lewat profile patch, untuk
deployment yang dikonfigurasi lewat berkas.

## Konfigurasi

Setiap field punya bawaan yang bekerja; config kosong tetap jalan.

| Kunci | Bawaan | Arti |
| --- | --- | --- |
| `enabled` | `true` | Apakah koneksi ikut hidup bersama harness |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Referensi kredensial tempat token disimpan |
| `baseUrl` | `https://api.telegram.org` | Origin Bot API; ubah hanya untuk proxy |
| `allowFrom` | `[]` | User ID yang diizinkan; kosong mengaktifkan alur klaim |
| `cwd` | cwd harness | Working directory untuk percakapan baru |
| `streaming.enabled` | `true` | Tampilkan jawaban sambil ditulis |
| `streaming.throttleMs` | `1200` | Jeda minimum antar frame stream |
| `streaming.placeholder` | `…` | Isi yang ditampilkan di bawah baris tool sebelum teks pertama tiba |
| `timeoutMs` | `30000` | Batas waktu tiap permintaan Bot API |
| `longPollSeconds` | `25` | Berapa lama Telegram menahan poll kosong |
| `media.enabled` | `true` | Baca gambar dan berkas teks yang dikirim |
| `media.maxBytes` | `20 MB` | Tolak yang lebih besar; Telegram membatasi unduhan bot di situ |
| `media.maxTextChars` | `60000` | Potong berkas teks pada jumlah karakter ini |
| `media.visionModel` | `""` | `provider/model` yang membaca gambar di sesi tersendiri; kosong mengirim gambarnya ke percakapan itu sendiri |
| `reconnect.baseDelayMs` | `1000` | Jeda sebelum percobaan sambung ulang pertama |
| `reconnect.maxDelayMs` | `30000` | Jeda terpanjang antar percobaan sambung ulang |

## Diagnostik

`ctx.logger` menulis ke sink apa pun yang dikomposisi deployment, dan beberapa
profile tidak mengomposisi satu pun — jadi plugin yang hanya mencatat
kegagalannya ke log sebenarnya bisu. Yang ini juga menulis keadaannya ke
`$DSH_HOME/dsh-telegram/status.json` pada setiap transisi:

```json
{ "state": "connected", "bot": "your_bot", "updatedAt": "..." }
```

`connecting`, `connected`, `idle` dengan alasan, `failed` dengan alasan. Token
bot tidak pernah muncul di sana.

## Hidup berdampingan dengan UI web

Harness hanya mengizinkan **satu** provider user-questions, dan di profile yang
juga menjalankan aplikasi web, browser sudah mengambilnya. Plugin ini mengambil
alih slot itu dan menyimpan provider browser sebagai cadangan: pertanyaan milik
sesi browser diteruskan kembali ke sana, dan yang milik percakapan Telegram jadi
tombol di chat. Melepas plugin ini mengembalikan susunan sebelumnya persis.

Permintaan izin memang komposabel — harness menjalankannya sebagai waterfall —
jadi plugin ini menjawab untuk sesinya sendiri dan meneruskan sisanya.

## Bagaimana semuanya tersambung

```
Telegram Bot API
      │  long poll: message + callback_query
      ▼
UpdatePoller ──► UpdateRouter ──┬──► SessionRunner ──► ctx.agents
                                │           │
                                │           └──► VisionExtractor ──► sesi
                                │                                    sekali-pakai
                                ├──► MediaCollector ──► ctx.attachments
                                ├──► TelegramQuestionProvider ──► ctx.userQuestions
                                └──► TelegramApprovalAnswerer ──► approval/request

ctx.on('session/event') ──┬──► VisionExtractor   (sesi pembacaannya sendiri)
                          └──► TurnBridge ──► RichReplyStream ──► sendRichMessage

TypingIndicator          (ditahan router dan bridge sampai balasan tampil)
```

### Bagaimana balasan di-stream

Telegram menyediakan dua mekanisme, dan keduanya tidak saling menggantikan:

- **Chat privat** memakai `sendRichMessageDraft` — preview efemeral yang
  beranimasi antar frame yang berbagi satu draft id. Ia kedaluwarsa 30 detik
  setelah frame terakhir, jadi ada heartbeat yang mengirim ulang teks saat ini
  selama tool call yang panjang; tanpa itu preview-nya lenyap dan bot terlihat
  mati. Draft tidak pernah tersimpan, jadi turn diakhiri dengan
  `sendRichMessage` sungguhan.
- **Grup tidak punya API draft.** Di sana balasan jadi langsung dikirim begitu
  siap.

Keduanya berakhir dengan satu rich message permanen.

### Tidak ada yang dikirim sebelum ada yang layak dikatakan

Indikator "typing…" bawaan Telegram yang menanggung masa tunggunya, dan balasan
baru muncul setelah ada isinya — kata pertama, atau nama tool yang dipakai
agent. Titik tiga yang dikirim begitu turn dibuka hanya memberitahu pengguna hal
yang sudah mereka tahu, dan di grup itu jadi pesan permanen yang mengatakannya.

Indikatornya **ditahan**, bukan dikirim sekali. `sendChatAction` habis setelah
lima detik — lebih pendek dari hampir semua hal yang layak ditunggu di sini:
mengunduh berkas, membaca gambar di model vision, turn yang mengantre di
belakang turn sebelumnya, atau satu menit di dalam tool call — jadi satu panggilan
terbaca sebagai bot yang mulai lalu mati. Tahanan dihitung per percakapan dan
dikirim ulang di dalam masa berlakunya sendiri, sehingga tahanan router saat
membaca lampiran dan tahanan bridge atas turn sesudahnya bertumpang tindih
dengan rapi, dan typing baru berhenti saat yang terakhir melepas. Ada batas
sepuluh menit untuk berjaga-jaga kalau pelepasan tidak pernah datang.

Selagi agent bekerja, tool yang sedang berjalan ditampilkan di atas balasan
dalam blok `<tg-thinking>`:

```
▸ bash: npm test

Ini yang saya temukan sejauh ini…
```

Telegram menerima blok itu di draft dan tidak di tempat lain, yang persis cocok
dengan masa hidupnya — ia hilang begitu turn dipermanenkan, jadi balasan akhir
membawa jawabannya, bukan perancah yang menghasilkannya. Hanya satu baris
terpotong: argumen sebuah tool bisa sepanjang satu berkas, dan tujuannya adalah
tahu agent masih hidup, bukan membaca transkrip.

## Pengembangan

```bash
pnpm install
pnpm test          # 549 test
pnpm test -- --coverage
pnpm typecheck     # paruh host dan browser
pnpm build         # tsc untuk host, esbuild untuk bundle browser
```

Setiap modul berjalan tanpa harness, dan itulah yang membuat suite-nya cepat:
entry plugin diuji terhadap stub HTTP sungguhan dari Bot API, dan bundle browser
dimaterialisasi persis seperti shell memateralisasinya.

### Paruh browser

`build.client.mjs` membungkus bundle CJS hasil esbuild dalam envelope lazy-CJS
factory milik shell (`window.__ModuleLoader__.load({ id, factory })`). Envelope
itu direproduksi, bukan diimpor: preset `clientBundle` milik harness tidak
dipublikasikan, dan dokumentasinya sendiri mencantumkan itu sebagai keterbatasan
untuk plugin di luar repo mereka.

Karena itu, di sinilah satu-satunya tempat plugin ini terikat ke format
internal, dan `test/client-bundle.test.ts` menguncinya — test itu menjalankan
build, memateralisasi factory-nya dengan `require` tiruan, lalu memastikan
`apply` mengambil kursi settings-nya. Rilis harness yang mengubah format itu
akan gagal di sana dengan nama yang jelas, bukan muncul sebagai halaman Settings
yang kosong.

React dan paket milik shell ditandai external; membundel React kedua akan
merusak setiap hook begitu halaman ter-mount.

## Keterbatasan yang diketahui

- **Grup belum punya gating.** Di grup, bot menjawab setiap pesan dari pengguna
  yang ada di daftar izin — tanpa perlu di-mention atau di-reply.
- **Reasoning effort belum terbawa.** Hanya provider dan model yang sampai ke
  sesi Telegram; effort yang dipilih di Settings → Models tidak.
- **Satu working directory.** Semua percakapan dimulai di `cwd` yang sama.
- **Belum ada voice, audio, atau video.** Seam attachment harness hanya
  menerima gambar.

## Lisensi

MIT
