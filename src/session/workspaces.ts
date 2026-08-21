/**
 * Which directory each Telegram conversation works in.
 *
 * Separate from the session binding on purpose: they have different lifetimes.
 * A binding is one conversation with the agent and dies with `/new`; the
 * directory a person chose is a property of the CHAT, and losing it every time
 * they start a fresh conversation would make `/cd` useless — the next message
 * would silently drop back to the configured default.
 *
 * A session's cwd is fixed when the session opens — the sandbox derives its
 * writable root from it, and the harness calls that root immutable — so
 * changing directory necessarily starts a new conversation. That is not a
 * quirk to hide: it is the reason this store exists apart from the bindings.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { ChatTarget } from '../interact/surface.js'

export class WorkspaceStore {
  private directories = new Map<string, string>()

  private constructor(private readonly file: string) {}

  /**
   * Load the store, or start empty when there is nothing readable yet.
   *
   * A corrupt file costs the user their chosen directories, which the next
   * `/cd` restores; refusing to start would cost them the bot.
   *
   * @param file - absolute path to the JSON document.
   */
  static async open(file: string): Promise<WorkspaceStore> {
    const store = new WorkspaceStore(file)
    store.directories = await read(file)
    return store
  }

  /** The directory this conversation chose, if it chose one. */
  forChat(target: ChatTarget): string | undefined {
    return this.directories.get(keyOf(target))
  }

  /**
   * Remember a conversation's directory.
   *
   * @param target - the conversation.
   * @param directory - an absolute path that has already been checked.
   */
  async set(target: ChatTarget, directory: string): Promise<void> {
    const next = new Map(this.directories)
    next.set(keyOf(target), directory)

    this.directories = next
    await this.persist()
  }

  /** Forget a conversation's directory, returning it to the configured default. */
  async clear(target: ChatTarget): Promise<void> {
    const next = new Map(this.directories)
    if (!next.delete(keyOf(target))) return

    this.directories = next
    await this.persist()
  }

  /** Write the document atomically, so a crash cannot leave a half file. */
  private async persist(): Promise<void> {
    const document = Object.fromEntries(this.directories)
    const temporary = `${this.file}.${process.pid}.tmp`

    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }
}

/**
 * Work out which directory a `/cd` argument names.
 *
 * Pure, so every spelling a person might type is pinned by a test rather than
 * discovered in a chat. Nothing here touches the filesystem — whether the
 * result exists is the caller's question, and a separate one.
 *
 * @param input - what the user typed after `/cd`.
 * @param current - the conversation's directory now, for relative paths.
 * @param home - the user's home directory, for `~`.
 * @returns an absolute, normalized path, or undefined for empty input.
 */
export function resolveDirectory(
  input: string,
  current: string,
  home: string,
): string | undefined {
  // Paths get pasted from a terminal, and a shell would have eaten the quotes.
  const trimmed = unquote(input.trim())
  if (trimmed === '') return undefined

  if (trimmed === '~') return resolve(home)
  if (trimmed.startsWith('~/')) return resolve(home, trimmed.slice(2))

  // A bare `~user` is deliberately NOT expanded: resolving another account's
  // home needs the password database, and guessing it wrong would silently
  // open a directory the user did not name.
  if (isAbsolute(trimmed)) return resolve(trimmed)

  return resolve(current, trimmed)
}

/** Strip one matching pair of surrounding quotes. */
function unquote(text: string): string {
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
  return quoted && text.length >= 2 ? text.slice(1, -1) : text
}

/** The durable key for one conversation; a forum topic is its own conversation. */
function keyOf(target: ChatTarget): string {
  return target.threadId === undefined ? target.chatId : `${target.chatId}#${target.threadId}`
}

/** Read the document, keeping only entries with a usable shape. */
async function read(file: string): Promise<Map<string, string>> {
  const directories = new Map<string, string>()

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return directories
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return directories
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return directories

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // A relative path here would resolve against whatever the process happens
    // to be running in, which is not what the user chose.
    if (typeof value === 'string' && value !== '' && isAbsolute(value)) directories.set(key, value)
  }

  return directories
}
