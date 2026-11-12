/**
 * 终端内快捷指令的行规程。shell 自己管行编辑，面板只在「shell 行为空」时
 * 截住开头的 `/`：缓冲仍是某条指令的前缀就本地回显，一旦不是（如
 * `/usr/bin/id`），擦掉本地回显、把已输入内容原样交给 shell。
 *
 * `clean` 是保守估计：只有回车 / Ctrl-C / Ctrl-U 之后才算空行；方向键、
 * 退格到空等一律视为不空，宁可不拦也不吞 shell 的输入。
 */

export type SlashLine = {
  /** shell 当前行是否为空（面板侧估计）。 */
  clean: boolean
  /** 正在本地编辑的指令；null = 未拦截。 */
  buf: string | null
}

export type SlashAction =
  | { kind: 'shell'; data: string }
  | { kind: 'echo'; data: string }
  | { kind: 'run'; name: string; echoed: number }

export const SLASH_IDLE: SlashLine = { clean: true, buf: null }

/** 光标回退 n 格并清到行尾：擦掉本地回显。 */
export function eraseEcho(n: number): string {
  return n > 0 ? `${'\b'.repeat(n)}\x1b[K` : ''
}

function resetsLine(data: string): boolean {
  const last = data[data.length - 1]
  return last === '\r' || last === '\x03' || last === '\x15'
}

function printable(data: string): boolean {
  // eslint-disable-next-line no-control-regex
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)
}

function handOff(buf: string, data: string) {
  const sent = buf + data
  return {
    line: { clean: resetsLine(sent), buf: null },
    actions: [
      { kind: 'echo', data: eraseEcho(buf.length) },
      { kind: 'shell', data: sent },
    ] as SlashAction[],
  }
}

/**
 * @param intercept 允许拦截：普通缓冲区（vim / less 等全屏程序在 alternate
 *   缓冲区里，`/` 是它们的搜索键）且确有指令。
 */
export function slashInput(
  line: SlashLine,
  data: string,
  names: readonly string[],
  intercept: boolean
): { line: SlashLine; actions: SlashAction[] } {
  const { buf } = line
  if (!intercept && buf !== null) return handOff(buf, data)
  const text =
    data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')
      ? data.slice(6, -6)
      : data
  if (buf === null) {
    if (
      line.clean &&
      intercept &&
      text.startsWith('/') &&
      names.some((name) => name.startsWith(text))
    ) {
      return {
        line: { clean: true, buf: text },
        actions: [{ kind: 'echo', data: text }],
      }
    }
    return {
      line: { clean: resetsLine(data), buf: null },
      actions: [{ kind: 'shell', data }],
    }
  }

  if (data === '\r') {
    if (names.includes(buf)) {
      return {
        line: SLASH_IDLE,
        actions: [{ kind: 'run', name: buf, echoed: buf.length }],
      }
    }
    return handOff(buf, data)
  }
  if (data === '\x7f' || data === '\b') {
    if (buf.length > 1) {
      return {
        line: { clean: true, buf: buf.slice(0, -1) },
        actions: [{ kind: 'echo', data: '\b \b' }],
      }
    }
    return { line: SLASH_IDLE, actions: [{ kind: 'echo', data: '\b \b' }] }
  }
  if (data === '\x03') {
    return {
      line: SLASH_IDLE,
      actions: [{ kind: 'echo', data: eraseEcho(buf.length) }],
    }
  }
  if (data === '\t') {
    const hits = names.filter((n) => n.startsWith(buf))
    if (hits.length !== 1) return { line, actions: [] }
    const rest = hits[0].slice(buf.length)
    return {
      line: { clean: true, buf: hits[0] },
      actions: rest ? [{ kind: 'echo', data: rest }] : [],
    }
  }
  if (printable(text)) {
    const next = buf + text
    if (names.some((n) => n.startsWith(next))) {
      return {
        line: { clean: true, buf: next },
        actions: [{ kind: 'echo', data: text }],
      }
    }
  }
  return handOff(buf, data)
}
