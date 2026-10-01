// usage-panel: TPS, token usage and API-equivalent cost for Claude Code.
//
// Data flow: turn.step (streaming) -> record tokens + generation time ->
// per-session doc in $.store ("s:<sessionId>") -> aggregated for the band and the pane.
// Each session writes only its own key, so concurrent sessions never overwrite each other.


const KEEP_DAYS = 40
const MIN_TPS_MS = 200
const MIN_TPS_TOKENS = 20

// USD per million tokens: [input, output, cache write (5 min), cache read].
// Order matters: the first matching pattern wins. Edit here when prices change.
const PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 12.5, 0.25],
  [/fable-5|mythos-5/, 10, 50, 12.5, 1],
  [/opus-5-5/, 4, 20, 5, 0.2],
  [/opus-5(?!\d)|opus-4-[5-8]/, 5, 25, 6.25, 0.5],
  [/opus-4-[01]|opus-4(?!-)/, 15, 75, 18.75, 1.5],
  [/sonnet-5/, 2, 10, 2.5, 0.2],
  [/sonnet-4/, 3, 15, 3.75, 0.3],
  [/haiku-4-5/, 1, 5, 1.25, 0.1],
  [/haiku-3-5/, 0.8, 4, 1, 0.08],
]

const priceOf = (model) => PRICES.find((p) => p[0].test(model))
const rowUsd = (model, r) => {
  const p = priceOf(model)
  if (!p) return 0
  return (r.i * p[1] + r.o * p[2] + r.cw * p[3] + r.cr * p[4]) / 1e6
}

// ---- formatting -------------------------------------------------------------------------

const fmtTok = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const fmtExact = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fmtUsd = (v) => (v >= 100 ? '$' + v.toFixed(0) : '$' + v.toFixed(2))
const fmtPct = (v) => (v * 100).toFixed(2) + '%'
const shortModel = (m) => m.replace(/^claude-/, '')

// ---- state ------------------------------------------------------------------------------

const emptyRow = () => ({ i: 0, o: 0, cr: 0, cw: 0, n: 0, gms: 0, gtok: 0 })
const emptyTotals = () => ({ ...emptyRow(), usd: 0 })

let sid = null // current session id
let doc = { days: {} } // this session: days[day][acct][model] = row
let others = {} // other sessions, as last read from the store
let cfg = { names: {}, hints: {}, range: '7', acct: 'all', exact: false, lang: 'auto' }
let curAcct = 'unknown'
let acctReadAt = 0
let lastFlush = 0
let flushTimer = null
let lastFullRefresh = 0

// UI state lives in $.state so a hot reload keeps it (module variables start over).
// Declared in types/index.d.ts. A read while drawing subscribes the drawing to the value.
const S_EXPANDED = { plugin: 'usage-panel', key: 'expanded' }
const S_EDITING = { plugin: 'usage-panel', key: 'editingName' }
const S_TPS = { plugin: 'usage-panel', key: 'tps' }

// ---- helpers that touch the mods API ----------------------------------------------------

async function today($) {
  const d = new Date(await $.clock.now())
  return dayKey(d)
}
function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// Accounts are identified by a short hash of their uuid; the uuid itself is never stored.
// The desktop app passes the session's account in CLAUDE_CODE_ACCOUNT_UUID and never updates
// ~/.claude.json, which only follows the CLI's own /login; so the env var wins and the file is
// the fallback for plain CLI sessions. Falls back to 'unknown' when neither can be read.
async function hashId(uuid) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid))
  return Array.from(new Uint8Array(buf))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
// "alice@example.com" -> "al…@example.com": enough to tell accounts apart at a glance.
const maskEmail = (email) => {
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, Math.min(2, at)) + '…' + email.slice(at) : ''
}
async function readCliAccount($) {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    if (!home) return null
    const a = JSON.parse(await $.fs.read(home + '/.claude.json'))?.oauthAccount
    return a?.accountUuid ? { uuid: a.accountUuid, email: a.emailAddress || '' } : null
  } catch {
    return null
  }
}
async function readAccount($) {
  try {
    const uuid = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
    if (uuid) return { id: await hashId(uuid), hint: maskEmail((await $.env.get('CLAUDE_CODE_USER_EMAIL')) || '') }
    const cli = await readCliAccount($)
    if (cli) return { id: await hashId(cli.uuid), hint: maskEmail(cli.email) }
  } catch {}
  return { id: 'unknown', hint: '' }
}
// Remembers the masked e-mail of the session's account and of the CLI's account, so each
// shows up under a recognisable label even before it has been renamed.
async function learnHints($) {
  const found = [await readAccount($)]
  const cli = await readCliAccount($)
  if (cli) found.push({ id: await hashId(cli.uuid), hint: maskEmail(cli.email) })
  let changed = false
  const hints = { ...(cfg.hints || {}) }
  for (const { id, hint } of found) {
    if (id !== 'unknown' && hint && hints[id] !== hint) {
      hints[id] = hint
      changed = true
    }
  }
  if (changed) {
    cfg = { ...cfg, hints }
    await saveCfg($)
  }
}
async function currentAccount($) {
  const now = await $.clock.now()
  if (now - acctReadAt > 5000) {
    curAcct = (await readAccount($)).id
    acctReadAt = now
  }
  return curAcct
}

async function ensureSession($) {
  const id = await $.session.id()
  if (id === sid) return
  sid = id
  const saved = await $.store.get('s:' + id)
  doc = saved && saved.days ? { days: saved.days } : { days: {} }
}

async function flush($) {
  if (!sid) return
  lastFlush = await $.clock.now()
  await $.store.set('s:' + sid, { upd: lastFlush, days: doc.days })
}
// Write at most every 2 seconds, and always once more after the last change.
function scheduleFlush($) {
  if (flushTimer) return
  flushTimer = $.clock.after(2000, async () => {
    flushTimer = null
    try {
      await flush($)
    } catch {}
  })
}

async function saveCfg($) {
  await $.store.set('cfg', cfg)
}

// Other sessions' docs. A quick pass re-reads only new sessions and those active in the last
// ACTIVE_MS (an idle session's doc does not change); a full pass every FULL_MS, or on the
// Refresh button, re-reads everything and drops docs older than KEEP_DAYS.
const ACTIVE_MS = 10 * 60000
const FULL_MS = 5 * 60000
async function refreshOthers($, full = false) {
  const keys = await $.store.keys()
  const now = await $.clock.now()
  if (now - lastFullRefresh > FULL_MS) full = true
  if (full) lastFullRefresh = now
  const next = {}
  for (const k of keys) {
    if (!k.startsWith('s:') || k === 's:' + sid) continue
    const cached = others[k]
    if (!full && cached && now - (cached.upd || 0) > ACTIVE_MS) {
      next[k] = cached
      continue
    }
    const v = await $.store.get(k)
    if (!v || !v.days) continue
    if (now - (v.upd || 0) > KEEP_DAYS * 86400000) {
      await $.store.delete(k)
      continue
    }
    next[k] = v
  }
  others = next
  $.ui.invalidate('ui.render')
}

// ---- recording --------------------------------------------------------------------------

async function record($, model, usage, gen) {
  if (!usage) return
  await ensureSession($)
  const day = await today($)
  const acct = await currentAccount($)
  const byAcct = (doc.days[day] ||= {})
  const byModel = (byAcct[acct] ||= {})
  const row = (byModel[model] ||= emptyRow())
  row.i += usage.input_tokens || 0
  row.o += usage.output_tokens || 0
  row.cr += usage.cache_read_input_tokens || 0
  row.cw += usage.cache_creation_input_tokens || 0
  row.n += 1
  if (gen && gen.ms >= MIN_TPS_MS && (usage.output_tokens || 0) >= MIN_TPS_TOKENS) {
    row.gms += gen.ms
    row.gtok += usage.output_tokens
    await $.state.set(S_TPS, { value: usage.output_tokens / (gen.ms / 1000), model })
  }
  scheduleFlush($)
  $.ui.invalidate('ui.render')
}

// ---- aggregation ------------------------------------------------------------------------

function lastDays(n, now) {
  const out = new Set()
  for (let k = 0; k < n; k++) out.add(dayKey(new Date(now - k * 86400000)))
  return out
}

// range: number of days. acctSel: 'all' or an account hash.
function aggregate(range, acctSel, now) {
  const days = lastDays(range, now)
  const tot = emptyTotals()
  const byModel = {}
  const byDay = {}
  const accts = new Set()
  const sources = [...Object.values(others), doc]
  for (const s of sources) {
    for (const [day, byAcct] of Object.entries(s.days || {})) {
      for (const [acct, models] of Object.entries(byAcct)) {
        accts.add(acct)
        if (!days.has(day)) continue
        if (acctSel !== 'all' && acct !== acctSel) continue
        for (const [model, r] of Object.entries(models)) {
          const usd = rowUsd(model, r)
          if (!priceOf(model)) tot.unpriced = true
          const m = (byModel[model] ||= emptyTotals())
          for (const t of [tot, m]) {
            t.i += r.i
            t.o += r.o
            t.cr += r.cr
            t.cw += r.cw
            t.n += r.n
            t.gms += r.gms
            t.gtok += r.gtok
            t.usd += usd
          }
          byDay[day] = (byDay[day] || 0) + usd
        }
      }
    }
  }
  // The current account is listed even before it has recorded anything.
  if (curAcct !== 'unknown') accts.add(curAcct)
  return { tot, byModel, byDay, accts: [...accts].sort() }
}

function sessionTotals() {
  const t = emptyTotals()
  for (const byAcct of Object.values(doc.days)) {
    for (const models of Object.values(byAcct)) {
      for (const [model, r] of Object.entries(models)) {
        if (!priceOf(model)) t.unpriced = true
        t.i += r.i
        t.o += r.o
        t.cr += r.cr
        t.cw += r.cw
        t.n += r.n
        t.gms += r.gms
        t.gtok += r.gtok
        t.usd += rowUsd(model, r)
      }
    }
  }
  return t
}

const cacheHit = (t) => {
  const denom = t.i + t.cr + t.cw
  return denom > 0 ? t.cr / denom : null
}
const avgTps = (t) => (t.gms > 0 ? t.gtok / (t.gms / 1000) : null)
// A total that leaves out a model with no price is a lower bound: shown as "≥ $x".
const usdOf = (t) => (t.unpriced ? '≥' : '') + fmtUsd(t.usd)

// Display width in cells: CJK, kana, Hangul and full-width forms take two.
const strWidth = (s) => {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}
// ---- i18n -------------------------------------------------------------------------------
// cfg.lang is 'auto' (follow the system language) or one of the codes below.
// To add a language: add an entry here, a name in LANG_NAMES, and a case in detectLang.

const LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  pt: 'Português',
  ru: 'Русский',
}
const LANG_ORDER = Object.keys(LANG_NAMES)

const STR = {
  en: {
    session: 'Session', today: 'Today', hit: 'Cache hit', more: 'Details', less: 'Close',
    d1: '1d', d7: '7d', d30: '30d', acct: 'Account', all: 'All', cur: 'current', acctN: 'Account {id}',
    edit: 'Rename', rnPh: 'Type a name, press Enter', save: 'Save',
    nodata: 'No data for the last {n} days yet. It starts counting after your next message.',
    sum: 'Last {n} days · API-equivalent value {usd} · {req} requests',
    total: 'Total', inAll: 'Input (all)', inp: 'Uncached input', out: 'Output (incl. thinking)', cr: 'Cache read', cw: 'Cache write', tps: 'TPS',
    models: 'Share by model (by value)', nopr: 'no price', daily: 'Daily value',
    tpsAvg: 'Average TPS by model',
    exact: 'Exact', kmb: 'K/M/B', refresh: 'Refresh', cmd: 'Expand or collapse the usage window',
  },
  'zh-CN': {
    session: '当前会话', today: '今日', hit: '缓存命中', more: '详情', less: '收起',
    d1: '1天', d7: '7天', d30: '30天', acct: '账户', all: '全部', cur: '当前', acctN: '账户 {id}',
    edit: '改名', rnPh: '输入名称后回车', save: '保存',
    nodata: '最近 {n} 天还没有数据，发一条消息后开始统计',
    sum: '最近 {n} 天 · API 等价价值 {usd} · {req} 次请求',
    total: '总计', inAll: '实际输入', inp: '未缓存输入', out: '输出（含思考）', cr: '缓存读', cw: '缓存写', tps: 'TPS',
    models: '各模型占比（按价值）', nopr: '无价格', daily: '每日价值',
    tpsAvg: '各模型平均 TPS',
    exact: '精确值', kmb: 'K/M/B', refresh: '刷新', cmd: '展开或收起用量小窗口',
  },
  'zh-TW': {
    session: '目前工作階段', today: '今日', hit: '快取命中', more: '詳情', less: '收合',
    d1: '1天', d7: '7天', d30: '30天', acct: '帳號', all: '全部', cur: '目前', acctN: '帳號 {id}',
    edit: '改名', rnPh: '輸入名稱後按 Enter', save: '儲存',
    nodata: '最近 {n} 天還沒有資料，傳送一則訊息後開始統計',
    sum: '最近 {n} 天 · API 等價價值 {usd} · {req} 次請求',
    total: '總計', inAll: '實際輸入', inp: '未快取輸入', out: '輸出（含思考）', cr: '快取讀取', cw: '快取寫入', tps: 'TPS',
    models: '各模型占比（依價值）', nopr: '無價格', daily: '每日價值',
    tpsAvg: '各模型平均 TPS',
    exact: '精確值', kmb: 'K/M/B', refresh: '重新整理', cmd: '展開或收合用量小視窗',
  },
  ja: {
    session: 'セッション', today: '今日', hit: 'キャッシュ命中', more: '詳細', less: '閉じる',
    d1: '1日', d7: '7日', d30: '30日', acct: 'アカウント', all: 'すべて', cur: '現在', acctN: 'アカウント {id}',
    edit: '名前変更', rnPh: '名前を入力して Enter', save: '保存',
    nodata: '直近 {n} 日のデータはまだありません。次のメッセージから集計します。',
    sum: '直近 {n} 日 · API 換算額 {usd} · {req} 回のリクエスト',
    total: '合計', inAll: '実質入力', inp: '非キャッシュ入力', out: '出力（思考含む）', cr: 'キャッシュ読取', cw: 'キャッシュ書込', tps: 'TPS',
    models: 'モデル別の割合（金額ベース）', nopr: '価格なし', daily: '日別の金額',
    tpsAvg: 'モデル別の平均 TPS',
    exact: '正確な値', kmb: 'K/M/B', refresh: '更新', cmd: '使用量ウィンドウを開閉',
  },
  ko: {
    session: '현재 세션', today: '오늘', hit: '캐시 적중', more: '자세히', less: '닫기',
    d1: '1일', d7: '7일', d30: '30일', acct: '계정', all: '전체', cur: '현재', acctN: '계정 {id}',
    edit: '이름 변경', rnPh: '이름 입력 후 Enter', save: '저장',
    nodata: '최근 {n}일 데이터가 아직 없습니다. 다음 메시지부터 집계합니다.',
    sum: '최근 {n}일 · API 환산 가치 {usd} · 요청 {req}회',
    total: '합계', inAll: '실제 입력', inp: '비캐시 입력', out: '출력(사고 포함)', cr: '캐시 읽기', cw: '캐시 쓰기', tps: 'TPS',
    models: '모델별 비중 (가치 기준)', nopr: '가격 없음', daily: '일별 가치',
    tpsAvg: '모델별 평균 TPS',
    exact: '정확한 값', kmb: 'K/M/B', refresh: '새로고침', cmd: '사용량 창 열기/닫기',
  },
  es: {
    session: 'Sesión', today: 'Hoy', hit: 'Acierto de caché', more: 'Detalles', less: 'Cerrar',
    d1: '1 d', d7: '7 d', d30: '30 d', acct: 'Cuenta', all: 'Todas', cur: 'actual', acctN: 'Cuenta {id}',
    edit: 'Renombrar', rnPh: 'Escribe un nombre y pulsa Enter', save: 'Guardar',
    nodata: 'Aún no hay datos de los últimos {n} días. Empieza a contar con tu próximo mensaje.',
    sum: 'Últimos {n} días · valor equivalente en API {usd} · {req} solicitudes',
    total: 'Total', inAll: 'Entrada total', inp: 'Entrada sin caché', out: 'Salida (con razonamiento)', cr: 'Lectura de caché', cw: 'Escritura de caché', tps: 'TPS',
    models: 'Reparto por modelo (por valor)', nopr: 'sin precio', daily: 'Valor diario',
    tpsAvg: 'TPS medio por modelo',
    exact: 'Exacto', kmb: 'K/M/B', refresh: 'Actualizar', cmd: 'Mostrar u ocultar la ventana de uso',
  },
  de: {
    session: 'Sitzung', today: 'Heute', hit: 'Cache-Treffer', more: 'Details', less: 'Schließen',
    d1: '1 T', d7: '7 T', d30: '30 T', acct: 'Konto', all: 'Alle', cur: 'aktuell', acctN: 'Konto {id}',
    edit: 'Umbenennen', rnPh: 'Namen eingeben, Enter drücken', save: 'Speichern',
    nodata: 'Noch keine Daten für die letzten {n} Tage. Die Zählung beginnt mit der nächsten Nachricht.',
    sum: 'Letzte {n} Tage · API-Gegenwert {usd} · {req} Anfragen',
    total: 'Gesamt', inAll: 'Eingabe gesamt', inp: 'Eingabe ohne Cache', out: 'Ausgabe (inkl. Denken)', cr: 'Cache gelesen', cw: 'Cache geschrieben', tps: 'TPS',
    models: 'Anteil je Modell (nach Wert)', nopr: 'kein Preis', daily: 'Tageswert',
    tpsAvg: 'Durchschnittliche TPS je Modell',
    exact: 'Exakt', kmb: 'K/M/B', refresh: 'Aktualisieren', cmd: 'Nutzungsfenster ein- oder ausklappen',
  },
  fr: {
    session: 'Session', today: "Aujourd'hui", hit: 'Succès du cache', more: 'Détails', less: 'Fermer',
    d1: '1 j', d7: '7 j', d30: '30 j', acct: 'Compte', all: 'Tous', cur: 'actuel', acctN: 'Compte {id}',
    edit: 'Renommer', rnPh: 'Saisissez un nom, puis Entrée', save: 'Enregistrer',
    nodata: "Pas encore de données sur les {n} derniers jours. Le suivi commence au prochain message.",
    sum: '{n} derniers jours · valeur équivalente API {usd} · {req} requêtes',
    total: 'Total', inAll: 'Entrée totale', inp: 'Entrée hors cache', out: 'Sortie (réflexion incl.)', cr: 'Lecture du cache', cw: 'Écriture du cache', tps: 'TPS',
    models: 'Répartition par modèle (en valeur)', nopr: 'sans prix', daily: 'Valeur par jour',
    tpsAvg: 'TPS moyen par modèle',
    exact: 'Exact', kmb: 'K/M/B', refresh: 'Actualiser', cmd: "Afficher ou masquer la fenêtre d'utilisation",
  },
  pt: {
    session: 'Sessão', today: 'Hoje', hit: 'Acerto de cache', more: 'Detalhes', less: 'Fechar',
    d1: '1 d', d7: '7 d', d30: '30 d', acct: 'Conta', all: 'Todas', cur: 'atual', acctN: 'Conta {id}',
    edit: 'Renomear', rnPh: 'Digite um nome e pressione Enter', save: 'Salvar',
    nodata: 'Ainda não há dados dos últimos {n} dias. A contagem começa na próxima mensagem.',
    sum: 'Últimos {n} dias · valor equivalente na API {usd} · {req} solicitações',
    total: 'Total', inAll: 'Entrada total', inp: 'Entrada sem cache', out: 'Saída (inclui raciocínio)', cr: 'Leitura de cache', cw: 'Gravação de cache', tps: 'TPS',
    models: 'Participação por modelo (por valor)', nopr: 'sem preço', daily: 'Valor diário',
    tpsAvg: 'TPS médio por modelo',
    exact: 'Exato', kmb: 'K/M/B', refresh: 'Atualizar', cmd: 'Expandir ou recolher a janela de uso',
  },
  ru: {
    session: 'Сессия', today: 'Сегодня', hit: 'Попадания в кэш', more: 'Подробнее', less: 'Закрыть',
    d1: '1 д', d7: '7 д', d30: '30 д', acct: 'Аккаунт', all: 'Все', cur: 'текущий', acctN: 'Аккаунт {id}',
    edit: 'Переименовать', rnPh: 'Введите имя и нажмите Enter', save: 'Сохранить',
    nodata: 'Данных за последние {n} дн. пока нет. Подсчёт начнётся со следующего сообщения.',
    sum: 'Последние {n} дн. · эквивалент по API {usd} · запросов: {req}',
    total: 'Всего', inAll: 'Ввод всего', inp: 'Ввод без кэша', out: 'Вывод (с рассуждениями)', cr: 'Чтение кэша', cw: 'Запись кэша', tps: 'TPS',
    models: 'Доля по моделям (по стоимости)', nopr: 'нет цены', daily: 'Стоимость по дням',
    tpsAvg: 'Средний TPS по моделям',
    exact: 'Точно', kmb: 'K/M/B', refresh: 'Обновить', cmd: 'Показать или скрыть окно использования',
  },
}

let autoLang = 'en'
const activeLang = () => (cfg.lang !== 'auto' && STR[cfg.lang] ? cfg.lang : autoLang)
const tr = (key, vars) => {
  const s = (STR[activeLang()] || STR.en)[key] ?? STR.en[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : '')) : s
}

// System language: the JS runtime's locale first, then the usual environment variables.
async function detectLang($) {
  let loc = ''
  try {
    loc = Intl.DateTimeFormat().resolvedOptions().locale || ''
  } catch {}
  if (!loc) loc = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  loc = loc.toLowerCase().replace('_', '-')
  if (loc.startsWith('zh')) return /tw|hk|mo|hant/.test(loc) ? 'zh-TW' : 'zh-CN'
  const base = loc.slice(0, 2)
  return STR[base] ? base : 'en'
}

// An account's name: the one given by renaming, else its masked e-mail, else "Account xxxx".
const acctName = (a) => cfg.names[a] || (cfg.hints || {})[a] || tr('acctN', { id: a.slice(0, 4) })
const acctLabel = (a) => acctName(a) + (a === curAcct ? ' (' + tr('cur') + ')' : '')

const toggleExpanded = async ($) => {
  await $.state.set(S_EXPANDED, !((await $.state.get(S_EXPANDED)).value ?? false))
  await $.state.set(S_EDITING, false)
}

// ---- module -----------------------------------------------------------------------------

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('cfg')
      if (saved && typeof saved === 'object') {
        cfg = { ...cfg, ...saved, names: { ...(saved.names || {}) }, hints: { ...(saved.hints || {}) } }
      }
      autoLang = await detectLang($)
      await ensureSession($)
      await currentAccount($)
      await learnHints($)
      await refreshOthers($, true)
      $.clock.every(15000, () => refreshOthers($).catch(() => {}))
    } catch {}
    try {
      await $.command.register({ name: 'usage-mod', description: tr('cmd'), immediate: true })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'usage-mod' }, async ($) => {
    await toggleExpanded($)
    return {}
  })

  // /clear, /resume and /branch change the session id: start from that session's own doc.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      sid = null
      await ensureSession($)
    } catch {}
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let first = 0
    let stopAt = 0
    let stopUsage = null
    const stream = next(e)
    for await (const c of stream) {
      try {
        if (!first && (c.kind === 'text' || c.kind === 'thinking' || c.kind === 'tool' || c.kind === 'input')) {
          first = await $.clock.now()
        } else if (c.kind === 'stop') {
          stopAt = await $.clock.now()
          stopUsage = c.usage
        }
      } catch {}
      yield c
    }
    const result = await stream.result
    try {
      const usage = stopUsage || result.usage
      if (usage) {
        const gen = first && stopAt ? { ms: stopAt - first } : null
        await record($, usage.model || e.model, usage, gen)
      }
    } catch {}
    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      await flush($)
    } catch {}
    return next(e)
  })

  // ---- the small window above the prompt ------------------------------------------------
  // Collapsed: one line that is always visible. Expanded: the same strip grows into a card
  // with the detail view. Nothing is drawn in a side pane. Everything is sized to bodyColumns.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select } = els
    const cols = e.props.bodyColumns || e.viewport?.columns || 100
    const expanded = (await $.state.get(S_EXPANDED)).value ?? false
    const editingName = (await $.state.get(S_EDITING)).value ?? false
    const tps = (await $.state.get(S_TPS)).value ?? null
    const now = await $.clock.now()
    const s = sessionTotals()
    const dayAgg = aggregate(1, curAcct === 'unknown' ? 'all' : curAcct, now)
    const day = dayAgg.tot
    const hit = cacheHit(s)
    const multi = dayAgg.accts.length > 1
    const toggleLabel = expanded ? tr('less') : tr('more')

    // The status text at three widths; the widest that fits beside the toggle is shown.
    const hitText = hit === null ? '—' : fmtPct(hit)
    const tpsText = tps ? tps.value.toFixed(1) + ' tok/s' : '— tok/s'
    const todayLabel = tr('today') + (multi ? ' (' + acctName(curAcct) + ')' : '')
    const variants = [
      [
        '⚡ ' + (tps ? shortModel(tps.model) + ' ' : '') + tpsText,
        tr('session') + ' ' + usdOf(s),
        todayLabel + ' ' + usdOf(day),
        tr('hit') + ' ' + hitText,
      ],
      ['⚡ ' + tpsText, tr('session') + ' ' + usdOf(s), tr('today') + ' ' + usdOf(day), tr('hit') + ' ' + hitText],
      ['⚡' + (tps ? tps.value.toFixed(0) : '—'), usdOf(s) + '/' + usdOf(day), hitText],
    ].map((p) => p.join(' · '))
    const room = cols - strWidth(toggleLabel) - 4
    const status = variants.find((v) => strWidth(v) <= room) || variants[variants.length - 1]

    const left = Box({
      key: 'usage-left',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ dimColor: true, wrap: 'truncate-end', children: [status] }),
        Button({ key: 'toggle-usage', label: toggleLabel, plain: true, onPress: () => toggleExpanded($) }),
      ],
    })

    // The language picker (a drop-down) sits at the right end of the top line while the card is open.
    const langOptions = [
      { value: 'auto', label: 'Auto · ' + LANG_NAMES[autoLang] },
      ...LANG_ORDER.map((code) => ({ value: code, label: LANG_NAMES[code] })),
    ]
    const line = expanded
      ? Box({
          key: 'usage-line',
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          children: [
            left,
            Select({
              key: 'lang',
              label: '🌐',
              options: langOptions,
              value: cfg.lang,
              onSelect: (v) => {
                cfg = { ...cfg, lang: v }
                $.ui.invalidate('ui.render')
                return saveCfg($)
              },
            }),
          ],
        })
      : left

    const children = [line]
    if (expanded) children.push(detailView($, els, now, cols, editingName))
    const rest = await next(e)
    if (rest) children.push(rest)
    return children.length === 1 ? line : Box({ flexDirection: 'column', children })
  })
}

// The expanded card: range, account, totals, per-model share, per-day value.
// cols is the band's width; the card's inside is 4 cells narrower (border and padding).
function detailView($, { Box, Text, Button, Input, Select }, now, cols, editingName) {
  const redraw = () => $.ui.invalidate('ui.render')
  const inner = Math.max(30, cols - 4)
  const wide = inner >= 66
  const range = Number(cfg.range)
  // A saved account that no longer has any data falls back to "all".
  const probe = aggregate(range, cfg.acct, now)
  const acctSel = cfg.acct === 'all' || probe.accts.includes(cfg.acct) ? cfg.acct : 'all'
  const agg = acctSel === cfg.acct ? probe : aggregate(range, 'all', now)
  const t = agg.tot
  const tok = (n) => (cfg.exact ? fmtExact(n) : fmtTok(n))

  const cell = (width, text, opts = {}) =>
    Box({ width, children: [Text({ ...opts, wrap: 'truncate-end', children: [String(text)] })] })
  // Numbers are right-aligned so their digits line up down a column.
  const num = (width, text) => Box({ width, justifyContent: 'flex-end', children: [Text({ children: [String(text)] })] })
  const row = (children) => Box({ flexDirection: 'row', columnGap: 1, children })
  // Drawn as two boxes, not █/░ glyphs: the desktop draws those wider than one cell, so a
  // glyph bar overran its column and covered the value beside it.
  const bar = (width, frac) => {
    const n = Math.max(0, Math.min(width, Math.round(frac * width)))
    return Box({
      width,
      height: 1,
      overflow: 'hidden',
      backgroundColor: 'gray',
      children: n > 0 ? [Box({ width: n, height: 1, backgroundColor: 'cyan', children: [Text({ children: [' '] })] })] : [],
    })
  }
  const setCfg = (patch) => {
    cfg = { ...cfg, ...patch }
    redraw()
    return saveCfg($)
  }
  const rangeBtn = (value, label, hotkey) =>
    Button({ key: 'range-' + value, label, hotkey, plain: true, dimColor: cfg.range !== value, onPress: () => setCfg({ range: value }) })

  const headerItems = [
    rangeBtn('1', tr('d1'), '1'),
    rangeBtn('7', tr('d7'), '2'),
    rangeBtn('30', tr('d30'), '3'),
    Select({
      key: 'acct',
      label: tr('acct'),
      options: [{ value: 'all', label: tr('all') }, ...agg.accts.map((a) => ({ value: a, label: acctLabel(a) }))],
      value: acctSel,
      onSelect: async (v) => {
        await $.state.set(S_EDITING, false)
        return setCfg({ acct: v })
      },
    }),
  ]
  // Renaming: a pencil button opens the field; saving writes the name and closes it again.
  if (acctSel !== 'all' && !editingName) {
    headerItems.push(
      Button({ key: 'edit-name', label: '✎ ' + tr('edit'), plain: true, onPress: () => $.state.set(S_EDITING, true) }),
    )
  }
  headerItems.push(
    Button({ key: 'unit', label: cfg.exact ? tr('exact') : tr('kmb'), plain: true, onPress: () => setCfg({ exact: !cfg.exact }) }),
    Button({ key: 'refresh', label: tr('refresh'), plain: true, onPress: () => refreshOthers($, true) }),
  )
  const header = Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: headerItems })

  const rename =
    acctSel !== 'all' && editingName
      ? [
          Input({
            key: 'rename',
            label: tr('edit'),
            placeholder: (cfg.hints || {})[acctSel] || tr('rnPh'),
            value: cfg.names[acctSel] || '',
            submitLabel: tr('save'),
            autoFocus: true,
            onSubmit: async (v) => {
              await $.state.set(S_EDITING, false)
              const names = { ...cfg.names }
              if (v.trim()) names[acctSel] = v.trim()
              else delete names[acctSel]
              return setCfg({ names })
            },
          }),
        ]
      : []

  const card = (children) => Box({ flexDirection: 'column', borderStyle: 'round', paddingX: 1, children })

  // Nothing recorded yet: say so in one line instead of drawing empty tables.
  if (t.n === 0) return card([header, ...rename, Text({ dimColor: true, children: [tr('nodata', { n: range })] })])

  // Totals: three columns when there is room, two otherwise.
  // The API splits a request's input three ways: cache read, cache write and the rest after
  // the last cache breakpoint (usually a few tokens). "Input (all)" is their sum, what the
  // model actually read; output tokens include thinking.
  const hit = cacheHit(t)
  const inAll = t.i + t.cr + t.cw
  const stats = [
    [tr('inAll'), tok(inAll)],
    [tr('out'), tok(t.o)],
    [tr('hit'), hit === null ? '—' : fmtPct(hit)],
    [tr('cr'), tok(t.cr)],
    [tr('cw'), tok(t.cw)],
    [tr('inp'), tok(t.i)],
  ]
  const perRow = inner >= 90 ? 3 : 2
  const statW = Math.floor((inner - (perRow - 1)) / perRow)
  const statRows = []
  for (let k = 0; k < stats.length; k += perRow) {
    statRows.push(row(stats.slice(k, k + perRow).map(([label, v]) => cell(statW, label + ' ' + v))))
  }
  const sumLine = tr('sum', { n: range, usd: usdOf(t), req: t.n }) + ' · ' + tr('total') + ' ' + tok(inAll + t.o)
  const summary = [Text({ bold: true, children: [sumLine] }), ...statRows]

  // Per-model rows: name, share, bar, value, and tokens when there is room. The bar takes
  // whatever width the other columns leave.
  const nameW = wide ? 20 : 14
  const fixed = nameW + 7 + 9 + (wide ? 10 : 0)
  const gaps = wide ? 4 : 3
  const barW = Math.max(6, Math.min(30, inner - fixed - gaps))
  const models = Object.entries(agg.byModel).sort((a, b) => b[1].usd - a[1].usd)
  const modelRows = models.map(([m, r]) => {
    const share = t.usd > 0 ? r.usd / t.usd : 0
    const cells = [
      cell(nameW, shortModel(m) + (priceOf(m) ? '' : ' ⚠ ' + tr('nopr'))),
      num(7, (share * 100).toFixed(1) + '%'),
      bar(barW, share),
      num(9, fmtUsd(r.usd)),
    ]
    if (wide) cells.push(num(10, tok(r.i + r.o + r.cr + r.cw)))
    return row(cells)
  })

  // Average TPS per model, fastest first; models with no measurable generation are left out.
  const tpsRows = models
    .map(([m, r]) => [m, avgTps(r)])
    .filter(([, v]) => v !== null)
    .sort((a, b) => b[1] - a[1])
    .map(([m, v]) => row([cell(nameW, shortModel(m)), num(9, v.toFixed(0) + ' t/s')]))
  const tpsSection = tpsRows.length ? [Text({ bold: true, children: [tr('tpsAvg')] }), ...tpsRows] : []

  let daily = []
  if (range > 1) {
    const dayList = []
    for (let k = range - 1; k >= 0; k--) dayList.push(dayKey(new Date(now - k * 86400000)))
    const withData = dayList.filter((d) => (agg.byDay[d] || 0) > 0)
    const max = Math.max(0, ...withData.map((d) => agg.byDay[d]))
    const dayBarW = Math.max(6, Math.min(30, inner - 7 - 9 - 2))
    if (withData.length) {
      daily = [
        Text({ bold: true, children: [tr('daily')] }),
        ...withData.map((d) => row([cell(7, d.slice(5)), bar(dayBarW, agg.byDay[d] / max), num(9, fmtUsd(agg.byDay[d]))])),
      ]
    }
  }

  return card([header, ...rename, ...summary, Text({ bold: true, children: [tr('models')] }), ...modelRows, ...tpsSection, ...daily])
}
