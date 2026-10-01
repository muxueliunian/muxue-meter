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
}

// Answers every noun the plugin calls beneath it. Files are matched by path suffix, so the
// same table serves C:\Users\x and /Users/x homes.
function world(on: On, w: World) {
  mock.clock(on, { now: NOW })
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
