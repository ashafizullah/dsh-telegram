<div align="center">

<h1>dsh-telegram</h1>

<p><strong>Ngobrol sama agent-mu lewat Telegram — dan bisa benar-benar menjawab waktu dia bertanya.</strong></p>

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

Ngobrol sama agent-mu dari HP — dan bisa benar-benar *menjawab* waktu dia bertanya.

## Kenapa ini ada

Menjalankan agent lewat aplikasi chat selalu mentok di dua hal. Plugin ini
dibuat untuk membereskan keduanya.

**Agent menulis markdown, Telegram menerimanya mentah-mentah.** Model menjawab
pakai `**tebal**`, heading, tabel, checklist, blok kode. Kalau dikirim sebagai
teks biasa, semua itu sampai ke kamu sebagai tumpukan bintang dan garis tegak.

Sejak Bot API 10.1, Telegram sudah bisa mem-parse markdown sendiri. Jadi plugin
ini meneruskan jawaban agent hampir apa adanya lewat `sendRichMessage` — tabel
tampil sebagai tabel, checklist sebagai checklist — dan batas pesannya naik dari
4096 jadi 32768 karakter.

**Agent bertanya, tapi tidak ada tempat buat menjawab.** Waktu agent memanggil
`ask_user_question`, atau ada tool yang butuh izinmu, harness berhenti dan
menunggu ada UI yang menjawab. Selama ini cuma browser yang bisa. Artinya
percakapan yang seluruhnya di Telegram bakal mandek di pertanyaan pertama, dan
tidak ada cara keluar. Plugin ini mendaftarkan diri sebagai UI itu, jadi
pertanyaan dan permintaan izin muncul sebagai tombol langsung di chat.

## Yang kamu butuhkan

- DeepSeek Harness dengan profile yang bisa ditambahi plugin
- **Bot API 10.1 ke atas**, untuk `sendRichMessage` dan `sendRichMessageDraft`
- Node 22 ke atas

Tidak ada mode cadangan HTML, dan memang tidak perlu. Parser markdown Telegram
cukup pemaaf — blok kode yang belum ditutup atau baris penuh simbol berantakan
tetap diterima, bukan ditolak — jadi potongan yang muncul di tengah streaming
aman-aman saja.

## Cara pasang

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @ashafizullah/dsh-telegram
```

Atau langsung dari source, kalau kamu mau ikut ngoprek:

```bash
git clone https://github.com/ashafizullah/dsh-telegram.git
cd dsh-telegram
pnpm install && pnpm build

npx @deepseek-ai/dsh plugin --profile web add -w "$(pwd)"
```

Habis itu kasih token bot. Bikin bot lewat [@BotFather](https://t.me/BotFather),
lalu simpan tokennya sebagai kredensial — jangan pernah ditaruh di file config:

```bash
npx @deepseek-ai/dsh credentials set TELEGRAM_BOT_TOKEN
```

Jalankan profile-nya. Di konsol akan muncul kode klaim:

```
[dsh-telegram] this bot has no owner yet. Message @your_bot with:

    /claim 3f9a2b1c
```

Kirim itu ke bot-mu, dan bot itu jadi milikmu. Sebelum itu dia tidak menjawab
siapa pun.

Kodenya juga ditulis ke `$DSH_HOME/dsh-telegram/claim-code.txt` dan cuma bisa
dibaca pemiliknya. Soalnya ada profile yang sama sekali tidak menyiapkan output
konsol — kalau kodenya tidak bisa dibaca siapa pun, bot-nya jadi mustahil
dipakai.

## Akses

Bot Telegram bisa dihubungi siapa saja yang tahu username-nya, dan agent di
baliknya bisa menjalankan perintah shell di komputermu. Makanya bawaannya
tertutup rapat.

- **Alur klaim** (bawaan): siapa pun yang pertama mengirim kode dari konsol jadi
  pemiliknya. Kepemilikan ini permanen dan cuma sekali — klaim berikutnya
  ditolak walaupun kodenya benar, jadi kode yang bocor tidak ada gunanya.
- **Daftar izin**: isi `allowFrom` dengan user ID Telegram kalau kamu mau lewat
  proses klaim sama sekali. Pakai `/whoami` buat tahu ID-mu.

Kode klaimnya ganti tiap restart, dan tidak pernah dikirim lewat Telegram.

Akses dicek paling awal, sebelum apa pun yang lain. Jadi tidak ada satu pun
pesan dari orang tak dikenal yang sampai ke agent — command sekalipun.

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

Selain itu, apa pun yang kamu ketik jadi prompt buat agent.

## Yang bisa kamu kirim

| Kamu kirim | Yang diterima agent |
| --- | --- |
| Teks | Prompt-nya |
| Foto, atau gambar yang dikirim sebagai file | Isi gambar yang dibaca model vision, beserta caption-mu |
| Berkas teks — log, stack trace, source | Isinya dalam prompt, dipotong bila sangat panjang |
| Voice note, audio, atau video | Catatan bahwa itu tidak bisa dibaca |

Gambar disimpan lewat jalur lampiran harness, yang menerima PNG, JPEG, WebP,
dan GIF. Format lain memang sengaja belum didukung di sana, jadi plugin ini
bilang terus terang daripada menerima pesanmu lalu diam-diam membuang isinya.

Jalur itu juga menolak gambar yang sisi terpanjangnya lewat dari
`maxImageDimension` — bawaannya 2000 piksel. Masalahnya, **semua** screenshot HP
setinggi layar pasti lewat: 1179×2556 di iPhone, 1080×2400 di kebanyakan
Android. Untungnya Telegram mengirim satu foto dalam beberapa ukuran sekaligus,
jadi yang dipakai adalah ukuran terbesar yang **muat**, bukan yang paling besar.
Batasnya dibaca langsung dari penyimpanannya sendiri, biar tidak ada angka
kembar yang bisa beda sendiri suatu hari. Kalau ternyata masih ditolak juga,
ukuran di bawahnya yang dicoba. Khusus gambar yang kamu kirim sebagai file —
ukurannya cuma satu, tidak ada yang bisa diturunkan — pesan penolakannya
menyebutkan batasnya dan menyarankan kirim sebagai foto saja, biar Telegram yang
menyediakan salinan lebih kecil.

Kalau filenya kebesaran atau gagal diunduh, itu jadi catatan singkat di prompt
yang menjelaskan kenapa — dan caption-mu tetap sampai ke agent.

### Modelnya harus bisa melihat

Model yang tidak mendukung input gambar akan menolak **seluruh** request, bukan
cuma gambarnya. Makanya gambar dicek dulu ke `inputModalities` sebelum dikirim.
**Tidak ada model DeepSeek yang bisa menerima gambar** — `deepseek-v4-flash` dan
`deepseek-v4-pro` dua-duanya cuma teks. Jadi kalau belum diatur apa-apa,
screenshot-mu ditolak dengan penjelasan model apa yang bakal berhasil, dan
caption-mu tetap sampai ke agent.

Buka **Settings → Telegram → Attachments**, di situ ada dropdown berisi model
yang sudah kamu tambahkan di Settings → Models. Pilih satu, dan gambar langsung
bisa dibaca.

Gambarnya sendiri tidak pernah masuk ke percakapanmu. Dia dikirim ke sesi
sekali-pakai di model tadi, yang diminta menyalin semua teks di dalamnya dan
menjelaskan singkat itu gambar apa. Jawabannya balik sebagai teks biasa, dan
**itulah** yang masuk ke percakapanmu, di bawah caption-mu sendiri. Sesi tadi
langsung dibuang — umurnya cuma satu turn.

Muter-muter begitu justru itu intinya. Provider mengecek seluruh riwayat
percakapan buat cari gambar, jadi satu gambar yang tertinggal di sana bakal
mengunci percakapan itu ke model yang bisa melihat, selamanya. Sekali kamu
kirim screenshot, semua pertanyaan sesudahnya — sepolos apa pun — ikut jalan di
sana, jauh dari model yang kamu pilih dan tool-tool yang sudah kamu siapkan.
Dengan membacanya di tempat lain, riwayatmu tetap bersih dari gambar. Jadi
percakapanmu tidak pindah ke mana-mana, tool-nya tetap ada, dan tidak pernah
nyangkut.

Kalau kamu belum mengatur model vision sama sekali, jalur ini tidak pernah
kepakai: gambarnya ditolak bahkan sebelum diunduh, lengkap dengan penjelasan
model mana yang cocok, dan caption-mu tetap sampai ke agent.

Kalau pembacaannya sudah dicoba tapi gagal — modelnya tidak bisa dihubungi, atau
kelamaan sampai lewat dua menit — gambarnya dikirim apa adanya, dan percakapanmu
yang pindah ke model vision, menetap di sana sampai kamu `/new`. Itu jalan
darurat, bukan rancangan aslinya, dan prompt-nya menyebutkan yang mana yang
terjadi.

Katalog model yang bisa dibaca browser tidak menyimpan info modalitas, jadi
dropdown-nya tidak bisa menandai model mana yang menerima gambar. Yang mengecek
itu host, waktu gambarnya benar-benar dikirim — cuma di situ jawabannya pasti.
Model vision masuk ke harness lewat provider yang membawanya, misalnya route
OpenAI-compatible yang kamu tambahkan di Settings → Models, yang entri modelnya
menyebut `input: [text, image]`.

### Kalau percakapan nyangkut

Kadang sebuah turn gagal dengan cara yang tidak akan sembuh walau dicoba
berkali-kali — dan paling sering ya kasus di atas: ada pesan lama yang membawa
sesuatu yang tidak diterima model sekarang, dan tidak ada yang bisa kamu ketik
untuk memperbaikinya. Bot mengenali kasus seperti itu, memberi tahu apa yang
gagal, lalu menawarkan tombol buat mulai percakapan baru. Menyuruh orang ingat
`/new` sendiri sama saja menyuruh mereka mendiagnosis plugin ini.

Kegagalan yang mungkin sembuh sendiri dilaporkan tanpa tombol, karena buat yang
itu mencoba lagi memang tindakan yang benar.

## Cara mengaturnya

Buka **Settings → Telegram** di UI web harness. Halaman itu menulis langsung ke
settings document — tidak ada tombol Save, karena perubahan yang tersimpan
langsung diterapkan host dengan menyambung ulang. Kalau formnya menahan draft
dulu, halaman dan bot yang sedang jalan bisa beda persepsi soal apa yang aktif.

Token bot pengecualian. Dia rahasia, jadi tidak pernah lewat jalur settings, ke
arah mana pun. Halaman itu cuma tahu *ada atau tidaknya* token tersimpan,
menulisnya lewat jalur credentials, dan menolak menawarkan edit untuk referensi
yang sudah disediakan environment — kalau dipaksakan, tulisannya bakal kelihatan
berhasil padahal yang kepakai tetap nilai dari environment.

Semua yang ada di halaman itu bisa juga diatur lewat profile patch, buat
deployment yang mengatur segalanya lewat file.

## Konfigurasi

Semua field punya nilai bawaan yang sudah jalan; config kosong pun tidak
masalah.

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

`ctx.logger` menulis ke mana pun deployment-mu mengarahkannya, dan ada beberapa
profile yang tidak mengarahkannya ke mana-mana — artinya plugin yang cuma
mencatat kegagalan ke log sebenarnya bisu. Makanya plugin ini juga menulis
keadaannya ke `$DSH_HOME/dsh-telegram/status.json` setiap kali berubah:

```json
{ "state": "connected", "bot": "your_bot", "updatedAt": "..." }
```

Isinya `connecting`, `connected`, `idle` beserta alasannya, atau `failed`
beserta alasannya. Token bot tidak pernah ikut muncul di sana.

## Berdampingan dengan UI web

Harness cuma mengizinkan **satu** provider user-questions, dan di profile yang
sekalian menjalankan aplikasi web, browser sudah keburu mengambilnya. Plugin ini
mengambil alih slot itu tapi tetap menyimpan provider browser sebagai cadangan:
pertanyaan yang berasal dari sesi browser diteruskan balik ke sana, dan yang
berasal dari percakapan Telegram jadi tombol di chat. Kalau plugin ini dilepas,
susunannya balik persis seperti semula.

Permintaan izin lebih mudah, karena harness memang menjalankannya berantai. Jadi
plugin ini menjawab untuk sesinya sendiri dan meneruskan sisanya.

## Cara kerjanya

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

TypingIndicator          (ditahan router dan bridge sampai balasan muncul)
```

### Cara jawaban ditampilkan sambil ditulis

Telegram punya dua mekanisme, dan keduanya tidak bisa saling menggantikan:

- **Chat pribadi** pakai `sendRichMessageDraft` — semacam preview sementara yang
  beranimasi antar potongan yang punya draft id sama. Preview ini hangus 30
  detik setelah potongan terakhir, jadi ada heartbeat yang mengirim ulang teks
  terkini selama tool call yang lama; tanpa itu preview-nya hilang dan bot
  kelihatan mati. Draft tidak pernah tersimpan, jadi turn-nya selalu ditutup
  dengan `sendRichMessage` beneran.
- **Grup tidak punya API draft sama sekali.** Di sana jawabannya langsung
  dikirim begitu selesai.

Dua-duanya berakhir jadi satu rich message permanen.

### Tidak ada yang dikirim sebelum ada yang layak dibilang

Masa tunggunya ditanggung indikator "typing…" bawaan Telegram, dan balasannya
baru muncul setelah benar-benar ada isinya — kata pertama, atau nama tool yang
lagi dipakai agent. Titik tiga yang muncul begitu turn dibuka cuma memberitahu
hal yang sudah kamu tahu, dan di grup itu malah jadi pesan permanen yang
mengatakannya.

Indikatornya **ditahan terus**, bukan dikirim sekali. `sendChatAction` cuma
bertahan lima detik — lebih pendek dari hampir semua hal yang bikin kamu
menunggu di sini: mengunduh file, membaca gambar di model vision, turn yang
masih ngantre di belakang turn sebelumnya, atau satu menit di dalam tool call.
Jadi sekali panggil doang bakal kebaca seperti bot yang nyala sebentar terus
mati. Sekarang tiap percakapan punya hitungannya sendiri dan indikatornya
dikirim ulang sebelum sempat hangus, jadi masa tunggu waktu router membaca
lampiran dan masa tunggu waktu turn-nya jalan bisa saling menyambung dengan
rapi — typing baru berhenti waktu yang terakhir selesai. Ada batas sepuluh menit
buat jaga-jaga kalau ada yang lupa berhenti.

Selagi agent bekerja, tool yang sedang jalan ditampilkan di atas balasan dalam
blok `<tg-thinking>`:

```
▸ bash: npm test

Ini yang saya temukan sejauh ini…
```

Telegram cuma menerima blok itu di dalam draft, dan tidak di tempat lain — kebetulan
persis sama dengan umur pakainya di sini. Blok itu hilang begitu turn-nya
dipermanenkan, jadi balasan akhirnya berisi jawaban, bukan proses di baliknya.
Isinya sengaja cuma satu baris pendek: argumen sebuah tool bisa sepanjang satu
file utuh, sementara yang kamu butuhkan cuma tahu agent-nya masih hidup, bukan
membaca transkrip.

## Pengembangan

```bash
pnpm install
pnpm test          # 549 test
pnpm test -- --coverage
pnpm typecheck     # sisi host dan sisi browser
pnpm build         # tsc untuk host, esbuild untuk bundle browser
```

Semua modul bisa jalan tanpa harness, dan itu yang bikin test-nya cepat: entry
plugin-nya diuji lawan stub HTTP Bot API sungguhan, dan bundle browser-nya
dimuat persis seperti shell memuatnya.

### Sisi browser

`build.client.mjs` membungkus bundle CJS hasil esbuild ke dalam pembungkus
lazy-CJS factory milik shell (`window.__ModuleLoader__.load({ id, factory })`).
Pembungkus itu ditulis ulang, bukan diimpor: preset `clientBundle` milik harness
memang tidak dipublikasikan, dan dokumentasinya sendiri mencantumkan itu sebagai
keterbatasan untuk plugin di luar repo mereka.

Jadi di sinilah satu-satunya tempat plugin ini terikat ke format internal, dan
`test/client-bundle.test.ts` yang menguncinya — test itu menjalankan build,
memuat factory-nya pakai `require` tiruan, lalu memastikan `apply` benar-benar
mengambil kursi settings-nya. Kalau rilis harness berikutnya mengubah formatnya,
yang gagal adalah test itu, dengan nama yang jelas — bukan muncul belakangan
sebagai halaman Settings yang kosong melompong.

React dan paket-paket milik shell ditandai external. Kalau sampai ada React
kedua ikut terbundel, semua hook rusak begitu halamannya ter-mount.

## Yang belum bisa

- **Grup belum ada filternya.** Di grup, bot menjawab semua pesan dari orang
  yang ada di daftar izin — tanpa perlu di-mention atau di-reply.
- **Reasoning effort belum ikut terbawa.** Cuma provider dan model yang sampai
  ke sesi Telegram; effort yang kamu pilih di Settings → Models tidak.
- **Working directory-nya cuma satu.** Semua percakapan mulai dari `cwd` yang
  sama.
- **Belum bisa voice, audio, atau video.** Jalur lampiran harness cuma menerima
  gambar.

## Lisensi

MIT
