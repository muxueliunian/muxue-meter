import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Run with: claude plugin test .
// Every test runs on both surfaces that take input, and none depends on the host OS: the
// Windows and macOS/Linux account paths are both driven through mocked env vars and files.

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 2, 3, 0, 0)

const band = (columns = 120) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: columns, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as const

const hash = async (uuid: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid))
  return Array.from(new Uint8Array(buf))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

type World = {
  env: Record<string, string>
  files?: Record<string, string>
  store?: Record<string, unknown>
  published?: string | null
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
}

// Answers every noun the plugin calls beneath it. Files are matched by path suffix, so the
// same table serves C:\Users\x and /Users/x homes.
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, w.store ?? {})
  mock.env(on, w.env)
  const files: Record<string, string> = { '/.claude-plugin/plugin.json': JSON.stringify({ version: '0.4.0' }), ...(w.files ?? {}) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.read', ($, e) => {
    const hit = Object.keys(files).find((k) => e.path.replace(/\\/g, '/').endsWith(k))
    if (!hit) throw new Error('ENOENT: ' + e.path)
    return { value: files[hit] }
  })
  on('fs.list', () => ({ value: [] }))
  on('http.fetch', () =>
    w.published
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: w.published }) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } },
  )
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: w.rateLimits ?? [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return clock
}

const start = ($: any, surface: string) => $.session.start({ cwd: '/work', surface, isInteractive: true })

test('desktop session: account from CLAUDE_CODE_ACCOUNT_UUID, labelled by masked e-mail', async ($, on) => {
  world(on, { env: { USERPROFILE: 'C:\\Users\\me', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop', CLAUDE_CODE_USER_EMAIL: 'alice@example.com' } })
  const id = await hash('uuid-desktop')
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    const acct = await ui.find({ key: 'acct' })
    expect(acct?.props.options).toContainEqual({ value: id, label: expect.stringContaining('al…@example.com') })
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('macOS / Linux CLI session: no USERPROFILE, account read from $HOME/.claude.json', async ($, on) => {
  world(on, {
    env: { HOME: '/Users/mac' },
    files: { '/Users/mac/.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'uuid-cli', emailAddress: 'bob@example.org' } }) },
  })
  const id = await hash('uuid-cli')
  await start($, 'terminal')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    const acct = await ui.find({ key: 'acct' })
    expect(acct?.props.options).toContainEqual({ value: id, label: expect.stringContaining('bo…@example.org') })
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('a newer published version shows the update badge', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, published: '0.5.0' })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /v0\.5\.0/ })).toBeDefined()
    await ui.unmount()
  }
})

test('no update badge when the published version is not newer', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, published: '0.4.0' })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /⬆/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('narrow band: the status line drops to its compact form', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' } })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band(40) })
    expect(await ui.find({ type: 'Text', text: /^⚡— · \$0\.00\/\$0\.00/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a rename keeps names another session saved meanwhile', async ($, on) => {
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: { names: { [other]: 'work' }, hints: {}, range: '7', acct: 'all', exact: false, lang: 'en' },
      's:old': { upd: NOW, days: { '2026-10-02': { [other]: { 'claude-opus-5-5': { i: 1, o: 1, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } } },
    },
  })
  const id = await hash('uuid-desktop')
  await start($, 'desktop')
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await ui.press({ key: 'toggle-usage' })
  await ui.select({ key: 'acct', value: id })
  await ui.press({ key: 'edit-name' })
  await ui.input({ key: 'rename', text: 'home' })
  const acct = await ui.find({ key: 'acct' })
  expect(acct?.props.options).toContainEqual({ value: id, label: expect.stringContaining('home') })
  expect(acct?.props.options).toContainEqual({ value: other, label: 'work' })
  await ui.unmount()
})

// ---- quota estimate ----------------------------------------------------------------------

const H = 3600000
const BUCKET = 5 * 60000
const bucket = (t: number) => String(Math.floor(t / BUCKET))
const iso = (t: number) => new Date(t).toISOString()
const enCfg = { names: {}, hints: {}, range: '7', acct: 'all', exact: false, lang: 'en' }
const measure = ($: any, rateLimits: unknown[]) =>
  $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })

test('quota: value recorded since the first reading divided by the rise of the fill', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // Another session of the same account read both windows at 0% two hours ago; $10 came
      // after that, $99 before it (not part of the rise).
      's:old': {
        upd: NOW,
        days: {},
        base: {
          [id]: {
            five_hour: { p: 0, r: NOW + 2 * H, at: NOW - 2 * H },
            seven_day: { p: 0, r: NOW + 72 * H, at: NOW - 2 * H },
          },
        },
        b: { [bucket(NOW - H)]: { [id]: { u: 10 } }, [bucket(NOW - 4 * H)]: { [id]: { u: 99 } } },
      },
    },
  })
  await start($, 'desktop')
  await measure($, [
    { kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) },
    { kind: 'seven_day', percentUsed: 2, resetsAt: iso(NOW + 72 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Predicted Week quota — \(after 3% more\)$/ })).toBeDefined()
    // Another tab: the quota rows give way, and the collapsed line still carries the fill.
    await ui.press({ key: 'tab-usage' })
    expect(await ui.find({ type: 'Text', text: /Predicted/ })).toBeUndefined()
    await ui.press({ key: 'toggle-usage' })
    expect(await ui.find({ type: 'Text', text: /· 5h 20% · Week 2%$/ })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('quota: recording that started mid-window divides only what came after the first reading', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // Recording began an hour ago, inside a window already 88% full ($100 before the first
      // reading at 88%, $5 after it). Dividing $105 by 92% would give a tiny, wrong quota.
      's:old': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 88, r: NOW + 3 * H, at: NOW - 40 * 60000 } } },
        b: { [bucket(NOW - 50 * 60000)]: { [id]: { u: 100 } }, [bucket(NOW - 20 * 60000)]: { [id]: { u: 5 } } },
      },
    },
  })
  await start($, 'terminal')
  // Only 4 points since the first reading: too few to divide by.
  await measure($, [{ kind: 'five_hour', percentUsed: 92, resetsAt: iso(NOW + 3 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota — \(after 1% more\)$/ })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
  // 10 points since the first reading: $5 / 10% = $50.
  await measure($, [{ kind: 'five_hour', percentUsed: 98, resetsAt: iso(NOW + 3 * H + 3000) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('quota: an estimate saved by 0.5.0 drafts (a part divided by the whole fill) is ignored', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: { cfg: enCfg, 's:old': { upd: NOW, days: {}, est: { [id]: { seven_day: { q: 1.41, low: true, r: NOW + H, at: NOW - H } } } } },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'seven_day', percentUsed: 92, resetsAt: iso(NOW + 6 * H) }])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await ui.press({ key: 'toggle-usage' })
  await ui.press({ key: 'tab-quota' })
  expect(await ui.find({ type: 'Text', text: /^Predicted Week quota — \(after 5% more\)$/ })).toBeDefined()
  await ui.unmount()
})

test('tabs are labelled in the chosen language; the toggle and language picker share the top line', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, store: { cfg: { ...enCfg, lang: 'zh-CN' } } })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    for (const [key, label] of [['tab-usage', '概览'], ['tab-quota', '额度'], ['tab-models', '模型'], ['tab-daily', '每日']]) {
      expect((await ui.find({ key }))?.props.label).toContain(label)
    }
    const right = await ui.find({ key: 'usage-right' })
    expect(right).toBeDefined()
    expect(await ui.find({ key: 'lang' })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    expect(await ui.find({ key: 'lang' })).toBeUndefined()
    await ui.unmount()
  }
})

test('quota: each account keeps its own readings; selecting one hides the others', async ($, on) => {
  const id = await hash('uuid-desktop')
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: { ...enCfg, names: { [other]: 'work' } },
      's:old': {
        upd: NOW,
        days: { '2026-10-02': { [other]: { 'claude-opus-5-5': { i: 1, o: 1, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } },
        base: { [other]: { five_hour: { p: 0, r: NOW + H, at: NOW - 2 * H } } },
        b: { [bucket(NOW - H)]: { [other]: { u: 30 } } },
        rl: { [other]: { five_hour: { p: 60, r: NOW + H, at: NOW - 10 * 60000 } } },
      },
    },
  })
  await start($, 'desktop')
  // This session's account: nothing recorded, so it has no estimate and must not borrow the other's $30.
  await measure($, [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 4 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota — \(after 5% more\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· work$/ })).toBeDefined()
    await ui.select({ key: 'acct', value: id })
    expect(await ui.find({ type: 'Text', text: /\$50\.00/ })).toBeUndefined()
    await ui.select({ key: 'acct', value: 'all' })
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('quota: a resumed session keeps its own saved estimate', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      's:session-1': { upd: NOW - 6 * H, days: {}, b: {}, est: { [id]: { five_hour: { q: 42, r: NOW - 5 * H, at: NOW - 6 * H, d: 1 } } } },
    },
  })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$42\.00$/ })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})


test("quota: a new window starts over from its own first reading", async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // The last window ended an hour ago (its baseline at 40%); the new one was first read at 0%
      // 30 minutes ago, in another session.
      's:old': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 40, r: NOW - H, at: NOW - 3 * H } } },
        rl: { [id]: { five_hour: { p: 95, r: NOW - H, at: NOW - 2 * H } } },
        b: { [bucket(NOW - 2 * H)]: { [id]: { u: 70 } }, [bucket(NOW - 20 * 60000)]: { [id]: { u: 6 } } },
      },
      's:new': { upd: NOW, days: {}, base: { [id]: { five_hour: { p: 0, r: NOW + 4.5 * H, at: NOW - 30 * 60000 } } } },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 6, resetsAt: iso(NOW + 4.5 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    await ui.press({ key: 'tab-quota' })
    // $6 in the new window over its 6%; the old window's $70 and its baseline play no part.
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$100$/ })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('quota: a CLI session whose ~/.claude.json names another account is filed under the true one', async ($, on) => {
  const named = await hash('uuid-cli')
  const real = await hash('uuid-real')
  world(on, {
    env: { HOME: '/Users/mac' },
    files: { '/Users/mac/.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'uuid-cli', emailAddress: 'bob@example.org' } }) },
    store: {
      cfg: { ...enCfg, names: { [named]: 'named', [real]: 'real' } },
      // Desktop sessions (account from the env var) saw each account's own week.
      's:a': {
        upd: NOW,
        src: 'env',
        days: { '2026-10-02': { [named]: { 'claude-opus-5-5': { i: 1, o: 1, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } },
        base: { [named]: { seven_day: { p: 10, r: NOW + 100 * H, at: NOW - H } } },
      },
      's:b': {
        upd: NOW,
        src: 'env',
        days: {},
        base: { [real]: { five_hour: { p: 0, r: NOW + 3 * H, at: NOW - 2 * H }, seven_day: { p: 30, r: NOW + 50 * H, at: NOW - 2 * H } } },
      },
      // This CLI session, under the named account, already spent $10 an hour ago.
      's:session-1': {
        upd: NOW,
        src: 'file',
        days: {},
        b: { [bucket(NOW - H)]: { [named]: { u: 10 } } },
        base: { [named]: { seven_day: { p: 31, r: NOW + 50 * H, at: NOW - 90 * 60000 } } },
      },
    },
  })
  await start($, 'terminal')
  // Its readings carry the real account's week: they, and the $10, are the real account's.
  await measure($, [
    { kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 3 * H) },
    { kind: 'seven_day', percentUsed: 35, resetsAt: iso(NOW + 50 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await ui.press({ key: 'toggle-usage' })
    const acct = await ui.find({ key: 'acct' })
    expect(acct?.props.options).toContainEqual({ value: real, label: 'real (current)' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /· real$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    // The named account keeps only its own week, at 10%, with nothing to divide.
    await ui.select({ key: 'acct', value: named })
    expect(await ui.find({ type: 'Text', text: /\$50\.00/ })).toBeUndefined()
    await ui.select({ key: 'acct', value: 'all' })
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('a session whose own saved doc is unreadable still counts the other sessions', async ($, on) => {
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      's:session-1': 'not a doc',
      's:old': { upd: NOW, days: { '2026-10-02': { [other]: { 'claude-sonnet-5-5': { i: 0, o: 1e6, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } } },
    },
  })
  await start($, 'desktop')
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await ui.press({ key: 'toggle-usage' })
  expect(await ui.find({ type: 'Text', text: /API-equivalent value \$10\.00/ })).toBeDefined()
  await ui.unmount()
})

test('expanded at desktop width: the status line keeps labels instead of the compact form', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: { ...enCfg, lang: 'zh-CN' } } })
  await start($, 'desktop')
  await measure($, [
    { kind: 'five_hour', percentUsed: 14, resetsAt: iso(NOW + 2 * H) },
    { kind: 'seven_day', percentUsed: 92, resetsAt: iso(NOW + 6 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band(100) })
    await ui.press({ key: 'toggle-usage' })
    expect(await ui.find({ type: 'Text', text: /当前会话 \$0\.00 · 今日 \$0\.00 .*5小时 14% · 每周 92%$/ })).toBeDefined()
    await ui.press({ key: 'toggle-usage' })
    await ui.unmount()
  }
})

test('an impossible speed (a timing glitch) is neither shown nor recorded', async ($, on) => {
  const clock = world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  // 1000 tokens whose first chunk came 0.5 s before the stop: 2000 tok/s, more than any model streams.
  on('turn.step', async function* ($: any, e: any, next: any) {
    await clock.advance(10000)
    yield { kind: 'text', index: 0, text: 'hi' }
    await clock.advance(500)
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  await start($, 'desktop')
  const stream: any = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any)
  for await (const _ of stream) {
  }
  await stream.result
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  expect(await ui.find({ type: 'Text', text: /^⚡ — tok\/s · Session \$0\.0\d/ })).toBeDefined()
  await ui.press({ key: 'toggle-usage' })
  await ui.press({ key: 'tab-models' })
  expect(await ui.find({ type: 'Text', text: /t\/s$/ })).toBeUndefined()
  await ui.unmount()
})

test("a subagent's requests count toward the session, and several at once keep their own timing", async ($, on) => {
  const clock = world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  // Sonnet 5.5 output at $10 per million: 100k tokens = $1.00 per request.
  const usage = { model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('turn.step', async function* ($: any, e: any, next: any) {
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(1000)
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  await start($, 'desktop')
  const run = async (input: any) => {
    const stream: any = $.turn.step(input)
    for await (const _ of stream) {
    }
    await stream.result
  }
  await Promise.all([
    run({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 }),
    run({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'agent-1' }),
    run({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'agent-2' }),
  ])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  expect(await ui.find({ type: 'Text', text: /Session \$3\.00/ })).toBeDefined()
  await ui.unmount()
})
