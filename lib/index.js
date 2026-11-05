/**
 * dsh-ai-calendar —— host 半边
 *
 * 把「AI 智能日历」（F:\AI calendar）以「同源托管」的方式嵌进 DeepSeek Harness：
 *
 *   · 静态托管  /dsh-calendar/app/*      → 项目 dist/（index.html 改写 base + 前置 shim）
 *   · API 反代  /dsh-calendar/api/*      → http://127.0.0.1:3001/api/*（含上传等原始流转发）
 *   · AI 接管   /dsh-calendar/api/ai/*   → 不落到应用自带的 provider/key，直接用 DSH 的 llm 服务
 *   · 后端托管  探测 3001，没起就 spawn server/index.cjs
 *   · Agent 工具 calendar_status / list / create / update / delete / summarize
 *
 * 同源托管是为了能控制 iframe 内部的 DOM（隐藏应用自带的 AI 助手）和主题，
 * 这些跨源是做不到的。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHIM_FILE = path.join(PACKAGE_ROOT, 'lib', 'shim.js')

// —— 诊断日志（host 与 client 共同写入同一份文件）——
const DIAG_DIR = path.join(os.tmpdir(), 'dsh-ai-calendar')
const DIAG_FILE = path.join(DIAG_DIR, 'diag.log')

function diagAppend(source, event, detail) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true })
    let tail = ''
    if (detail !== undefined) {
      try {
        tail = typeof detail === 'string' ? detail : JSON.stringify(detail)
      } catch {
        tail = String(detail)
      }
    }
    if (tail.length > 4000) tail = `${tail.slice(0, 4000)}…`
    fs.appendFileSync(DIAG_FILE, `${new Date().toISOString()} [${source}] ${event} ${tail}\n`, 'utf8')
  } catch {
    /* 日志写失败不能影响主流程 */
  }
}

/**
 * 被嵌入的日历资源根目录。
 *
 * 优先级：
 *   1. DSH_CALENDAR_ROOT / DSH_CALENDAR_APP_ROOT —— 显式指定（开发时指向源码项目）
 *   2. 包内 rsc/ —— 发布版的默认位置，包含 dist/ 与 server/index.cjs
 *   3. 包的同级目录 —— 老式「插件与项目并列」的开发布局
 */
const BUNDLED_ROOT = path.join(PACKAGE_ROOT, 'rsc')

function resolveProjectRoot() {
  const explicit = process.env.DSH_CALENDAR_ROOT || process.env.DSH_CALENDAR_APP_ROOT
  if (explicit && fs.existsSync(path.join(explicit, 'dist'))) return path.resolve(explicit)
  if (fs.existsSync(path.join(BUNDLED_ROOT, 'server', 'index.cjs'))) return BUNDLED_ROOT
  return path.resolve(PACKAGE_ROOT, '..')
}

const PROJECT_ROOT = resolveProjectRoot()
const DIST_DIR = path.join(PROJECT_ROOT, 'dist')
/** 日历后端端口（server/index.ts 里写死 3001）。 */
const BACKEND_PORT = Number(process.env.DSH_CALENDAR_PORT || 3001)
const BACKEND_HOST = '127.0.0.1'

const ROUTE_ROOT = '/dsh-calendar'
const APP_PREFIX = `${ROUTE_ROOT}/app`
const API_PREFIX = `${ROUTE_ROOT}/api`
const SHIM_PATH = `${APP_PREFIX}/__shim.js`

const START_TIMEOUT_MS = 20000

/** 后端进程与其归属状态。只被杀掉「我们自己拉起的」那一个。 */
let backendChild = null
let ensureInflight = null
let lastStartError = ''
let lastStartVia = ''
/** 由 apply 注入的 llm 访问器（可选服务，缺了就只影响 AI 接管）。 */
let getLlm = () => null

// ---------------------------------------------------------------------------
// 后端进程托管
// ---------------------------------------------------------------------------

function backendEntryFile() {
  const cjs = path.join(PROJECT_ROOT, 'server', 'index.cjs')
  return fs.existsSync(cjs) ? cjs : ''
}

/** 探测后端是否已在 3001 上正常应答。 */
async function probeHealth(timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}/api/logs?start=1970-01-01&end=1970-01-01`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return false
    const body = await res.json()
    return Array.isArray(body)
  } catch {
    return false
  }
}

async function waitHealthy(deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await probeHealth(1000)) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

/**
 * 启动候选：优先系统 node（本项目 better-sqlite3 原生模块是按 Node ABI 构建的），
 * 回退到 DSH 自己的运行时（Electron 以 ELECTRON_RUN_AS_NODE 充当 node）。
 */
function startCandidates() {
  const entry = backendEntryFile()
  if (!entry) return []
  const baseEnv = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' }
  const candidates = [
    { label: 'node', file: 'node', args: [entry], env: baseEnv },
  ]
  if (process.execPath && process.execPath !== 'node') {
    candidates.push({
      label: 'dsh-runtime-node',
      file: process.execPath,
      args: [entry],
      env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
    })
  }
  return candidates
}

function killBackend() {
  if (!backendChild) return
  try {
    backendChild.kill()
  } catch {
    /* 已经退出 */
  }
  backendChild = null
}

/**
 * 保证日历后端在线。幂等且并发安全：同时多次调用只会拉起一个进程。
 * @returns {Promise<{running: boolean, spawned: boolean, port: number, url: string, error?: string}>}
 */
function ensureBackend() {
  if (ensureInflight) return ensureInflight
  ensureInflight = (async () => {
    const url = `${APP_PREFIX}/`
    if (await probeHealth()) {
      return { running: true, spawned: false, port: BACKEND_PORT, url }
    }
    const candidates = startCandidates()
    if (candidates.length === 0) {
      lastStartError = `找不到 ${path.join(PROJECT_ROOT, 'server', 'index.cjs')}，请先在项目里执行 npm run build:server`
      return { running: false, spawned: false, port: BACKEND_PORT, url, error: lastStartError }
    }
    for (const candidate of candidates) {
      try {
        const child = spawn(candidate.file, candidate.args, {
          cwd: PROJECT_ROOT,
          env: candidate.env,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.on('error', () => {})
        backendChild = child
        lastStartVia = candidate.label
        if (await waitHealthy(START_TIMEOUT_MS)) {
          return { running: true, spawned: true, port: BACKEND_PORT, url, via: candidate.label }
        }
        lastStartError = `${candidate.label} 启动后 ${START_TIMEOUT_MS}ms 内未就绪`
        killBackend()
      } catch (err) {
        lastStartError = `${candidate.label}: ${(err && err.message) || err}`
        killBackend()
      }
    }
    return { running: false, spawned: false, port: BACKEND_PORT, url, error: lastStartError }
  })()
  return ensureInflight.finally(() => {
    ensureInflight = null
  })
}

/** 供工具使用的后端 JSON 请求。 */
async function apiJson(pathname, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const health = await ensureBackend()
  if (!health.running) {
    throw new Error(`日历后端未就绪：${health.error || '未知原因'}`)
  }
  const res = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}${pathname}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!res.ok) {
    const contentType = String(res.headers.get('content-type') || '')
    const looksHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text)
    // 后端抛未捕获异常时 Express 会回一整页 HTML，绝不能把整页塞进对话里
    if (looksHtml) {
      diagAppend('host', 'api:html-error', {
        pathname,
        method,
        status: res.status,
        body: text.slice(0, 800),
      })
      throw new Error(
        res.status >= 500
          ? `日历后端返回 ${res.status}（服务异常，多半是数据库正被占用或后端正在重启），这条已跳过，稍后重试即可`
          : `日历后端返回 ${res.status}`,
      )
    }
    const message = (parsed && typeof parsed === 'object' && parsed.error)
      || (typeof parsed === 'string' ? parsed.slice(0, 200) : '')
      || `HTTP ${res.status}`
    throw new Error(message)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 静态托管（同源）
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function statOf(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function readFileText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 把 dist/index.html 改成「挂在子路径下」的版本，并前置 shim。 */
function renderIndexHtml() {
  const raw = readFileText(path.join(DIST_DIR, 'index.html'))
  if (!raw) {
    return '<!doctype html><meta charset="utf-8"><title>AI 智能日历</title>'
      + '<body style="font:14px/1.6 system-ui;padding:32px">找不到项目构建产物 dist/index.html，'
      + '请先在 F:\\AI calendar 执行 <code>npm run build</code>。</body>'
  }
  // 先删掉 index.html 里所有 base（历史构建里出现过重复），再在 head 最前面插一个，
  // 保证相对资源一律按 /dsh-calendar/app/ 解析。
  let html = raw.replace(/<base\b[^>]*>/gi, '')
  html = html.replace(/<head[^>]*>/i, (match) => `${match}\n    <base href="${APP_PREFIX}/">`)
  const shimTag = `<script src="${SHIM_PATH}" data-dsh-ai-calendar-shim="1"></script>`
  if (html.includes('data-dsh-ai-calendar-shim')) return html
  html = html.replace(/<head[^>]*>/i, (match) => `${match}\n    ${shimTag}`)
  return html
}

function serveApp(req, res, pathname) {
  if (pathname === SHIM_PATH) {
    const source = readFileText(SHIM_FILE)
    if (!source) {
      sendText(res, 500, '/* dsh-ai-calendar: shim.js 缺失 */', 'application/javascript; charset=utf-8')
      return
    }
    sendText(res, 200, source, 'application/javascript; charset=utf-8')
    return
  }

  const rest = pathname.slice(APP_PREFIX.length).replace(/^\/+/, '')
  let target = rest ? path.join(DIST_DIR, decodeURIComponent(rest)) : path.join(DIST_DIR, 'index.html')

  // 目录穿越保护
  const normalized = path.resolve(target)
  if (normalized !== DIST_DIR && !normalized.startsWith(DIST_DIR + path.sep)) {
    sendText(res, 403, 'forbidden')
    return
  }

  let stat = statOf(normalized)
  // 无扩展名的深链接 → SPA 回退到 index.html
  if (!stat && !path.extname(normalized)) {
    target = path.join(DIST_DIR, 'index.html')
    stat = statOf(target)
  }
  if (!stat) {
    sendText(res, 404, `not found: ${rest || 'index.html'}`)
    return
  }

  const file = path.resolve(target)
  if (path.basename(file).toLowerCase() === 'index.html') {
    sendText(res, 200, renderIndexHtml(), 'text/html; charset=utf-8')
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', mimeOf(file))
  res.setHeader('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.setHeader('content-length', String(stat.size))
  const stream = fs.createReadStream(file)
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 500
    res.end()
  })
  stream.pipe(res)
}

// ---------------------------------------------------------------------------
// API 反代
// ---------------------------------------------------------------------------

function proxyToBackend(req, res, pathname, search) {
  const targetPath = pathname.slice(ROUTE_ROOT.length) + (search || '')
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` }
  delete headers.connection

  const upstream = http.request({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    method: req.method,
    path: targetPath,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: `日历后端不可达：${(err && err.message) || err}` })
      return
    }
    try {
      res.end()
    } catch {
      /* ignore */
    }
  })

  req.pipe(upstream)
}

// ---------------------------------------------------------------------------
// AI 接管：用 DSH 已配置的 DeepSeek（llm 服务）替掉应用自带的 provider/key
// ---------------------------------------------------------------------------

const LOG_CATEGORIES = ['meeting', 'task', 'chore', 'personal', 'work', 'study', 'health', 'other']

let llmRoute = null
let llmRouteInflight = null

/** 选一个 DeepSeek 路由（provider + model），结果缓存。 */
async function resolveLlmRoute(llm) {
  if (llmRoute) return llmRoute
  if (llmRouteInflight) return llmRouteInflight
  llmRouteInflight = (async () => {
    const providers = (await llm.listProviders()) || []
    if (providers.length === 0) throw new Error('DSH 当前没有可用的 LLM provider')
    const picked = providers.find((p) => /deepseek/i.test(p.id))
      || providers.find((p) => /deepseek/i.test(p.name || ''))
      || providers[0]
    let model = process.env.DSH_CALENDAR_AI_MODEL || ''
    if (!model) {
      try {
        const models = (await llm.listModels(picked.id)) || []
        if (models.length > 0) model = models[0].id
      } catch {
        /* 列不出模型就让调用方报错 */
      }
    }
    if (!model) throw new Error(`provider ${picked.id} 没有可发现的模型，可用 DSH_CALENDAR_AI_MODEL 指定`)
    llmRoute = { provider: picked.id, model, displayName: picked.name || picked.id }
    return llmRoute
  })()
  try {
    return await llmRouteInflight
  } finally {
    llmRouteInflight = null
  }
}

/** 调一次模型，收全文。 */
// —— AI 计费：用于「按量付费」提示与每次消耗展示 ——
// 单价按「元 / 百万 token」计，可用环境变量覆盖（默认按 DeepSeek 现行公开价估算）。
const PRICE_INPUT_PER_M = Number(process.env.DSH_CALENDAR_PRICE_INPUT_PER_M || 2)
const PRICE_OUTPUT_PER_M = Number(process.env.DSH_CALENDAR_PRICE_OUTPUT_PER_M || 8)

const aiStats = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costRmb: 0,
  last: null,
}

function costOf(usage) {
  if (!usage) return null
  const inputTokens = Number(usage.inputTokens || 0)
  const outputTokens = Number(usage.outputTokens || 0)
  const rmb = (inputTokens / 1e6) * PRICE_INPUT_PER_M + (outputTokens / 1e6) * PRICE_OUTPUT_PER_M
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    rmb: Number(rmb.toFixed(6)),
  }
}

async function askModel({ system, prompt, maxTokens = 800, identity = false }) {
  const llm = getLlm()
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('DSH 的 llm 服务不可用')
  }
  const route = await resolveLlmRoute(llm)
  // 需要模型自报家门时，把真实模型写进系统提示——但只给「自然说法」，不给调试字段。
  let finalSystem = system
  if (identity) {
    finalSystem = (system ? `${system}\n\n` : '')
      + `[背景] 你运行在 DeepSeek Harness 中，背后调用的是 DeepSeek API，当前模型为 ${route.model}，按 token 计费。`
      + '用户问到你用的是什么模型时，用一句自然的中文回答即可，例如「我用的是 DeepSeek 的 '
      + `${route.model}」。`
      + '禁止输出 provider、反引号、Markdown 星号等技术细节，也禁止罗列参数；不要道歉或解释你是如何得知的。'
  }
  let text = ''
  let usage = null
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system: finalSystem,
    maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })
  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') {
      text += chunk.text || ''
    } else if (chunk.type === 'usage') {
      usage = chunk.usage || usage
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind
      if (kind === 'error') {
        const message = (chunk.reason.failure && chunk.reason.failure.message) || '模型调用失败'
        throw new Error(message)
      }
      if (kind === 'aborted') throw new Error('模型调用被取消')
    }
  }
  const cost = costOf(usage)
  if (cost) {
    aiStats.calls += 1
    aiStats.inputTokens += cost.inputTokens
    aiStats.outputTokens += cost.outputTokens
    aiStats.costRmb = Number((aiStats.costRmb + cost.rmb).toFixed(6))
    aiStats.last = { at: new Date().toISOString(), ...cost, provider: route.provider, model: route.model }
  }
  return { text: text.trim(), usage, cost, provider: route.provider, model: route.model }
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const text = await readBody(req)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => (block && block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 分类：只返回一个合法类目。 */
async function classifyLog(title, content) {
  const prompt = [
    '把下面这条日历记录归类到且仅归到以下类目之一：',
    LOG_CATEGORIES.join(', '),
    '',
    `标题：${title || ''}`,
    `内容：${content || ''}`,
    '',
    '只输出类目英文单词本身，不要标点、不要解释。',
  ].join('\n')
  const result = await askModel({
    system: '你是严谨的日历日志分类器，只输出一个类目单词。',
    prompt,
    maxTokens: 16,
  })
  const cleaned = String(result.text || '').toLowerCase().replace(/[^a-z]/g, '')
  return { category: LOG_CATEGORIES.includes(cleaned) ? cleaned : 'other', cost: result.cost }
}

/** 处理 /dsh-calendar/api/ai/*；返回 false 表示这个路径不归 AI 接管。 */
// ---------------------------------------------------------------------------
// 日历对话的真实写库通路
//
// 原来的 /ai/chat 只是把历史拼成 prompt 调一次补全：模型没有任何写库能力，
// 却会因为「你是智能日历助手」这个身份直接编出「已创建任务」。
// 这里改成「模型出动作 → 插件执行 → 回填真实结果」：
//   1. 系统提示里给出 logs 表字段、今天的日期、以及严格的 JSON 契约；
//   2. 解析模型给出的 ops（create / update / delete）；
//   3. 通过日历后端 REST 接口真的落库（后端用参数化语句写同一个 SQLite）；
//   4. 成功时**不追加任何技术信息**；只有失败才补一句人话，避免模型嘴硬说"已安排"。
// 走 REST 而不是在宿主进程里直接开 SQLite：日历后端持有单个 better-sqlite3
// 连接与 WAL，第二次连接既可能撞 ABI，也会让前端状态不同步。
// ---------------------------------------------------------------------------

const ADD_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本机当前日期/时间，「今天」「明天」这类相对说法靠它落地。 */
function calendarNow() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    weekday: ADD_WEEKDAYS[now.getDay()],
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}

/** 模型允许写的列（id / created_at / updated_at / ai_summary 不让模型碰）。 */
const WRITABLE_FIELDS = [
  'title', 'content', 'category', 'date', 'start_time', 'end_time',
  'is_periodic', 'periodic_type', 'periodic_value',
  'reminder_enabled', 'reminder_time', 'advance_minutes',
  'completed', 'color', 'is_task', 'priority', 'status',
]
const BOOL_FIELDS = new Set(['is_periodic', 'reminder_enabled', 'completed', 'is_task'])
const INT_FIELDS = new Set(['advance_minutes', 'priority'])
/** 渲染 SQL 时的列顺序，与建表顺序一致，读起来更像人写的语句。 */
const SQL_COLUMNS = [
  'id', 'title', 'content', 'category', 'date', 'start_time', 'end_time',
  'is_periodic', 'periodic_type', 'periodic_value',
  'reminder_enabled', 'reminder_time', 'advance_minutes',
  'completed', 'color', 'is_task', 'priority', 'status',
]

/** 把模型给的 payload 收敛成合法列 + 正确类型，未知键直接丢弃。 */
function normalizeFields(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of WRITABLE_FIELDS) {
    if (raw[key] === undefined || raw[key] === null) continue
    const value = raw[key]
    if (BOOL_FIELDS.has(key)) {
      out[key] = value === true || value === 1 || value === '1' || value === 'true'
    } else if (INT_FIELDS.has(key)) {
      const num = Number(value)
      if (!Number.isFinite(num)) continue
      out[key] = Math.trunc(num)
    } else {
      const text = String(value).trim()
      if (text === '') continue
      out[key] = text
    }
  }
  return out
}

/** SQL 字面量（只用于「展示」，参数化写入由后端完成）。 */
function sqlLiteral(value) {
  if (value === undefined || value === null || value === '') return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(/'/g, "''")}'`
}

function cellSql(column, value) {
  if (BOOL_FIELDS.has(column)) return value ? '1' : '0'
  return sqlLiteral(value)
}

function insertSqlFor(log) {
  const columns = []
  const values = []
  for (const column of SQL_COLUMNS) {
    if (log[column] === undefined) continue
    columns.push(column)
    values.push(cellSql(column, log[column]))
  }
  return `INSERT INTO logs (${columns.join(', ')}) VALUES (${values.join(', ')});`
}

function updateSqlFor(id, patch) {
  const sets = Object.keys(patch).map((key) => `${key} = ${cellSql(key, patch[key])}`)
  if (sets.length === 0) return ''
  return `UPDATE logs SET ${sets.join(', ')}, updated_at = datetime('now', 'localtime') WHERE id = ${sqlLiteral(id)};`
}

function deleteSqlFor(id) {
  return `DELETE FROM logs WHERE id = ${sqlLiteral(id)};`
}

/** 从模型输出里捞出第一个能解析的 JSON 对象（容忍代码围栏、前后废话、无关花括号）。 */
function extractJsonObject(text) {
  if (typeof text !== 'string' || text === '') return null
  const candidates = []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])
  candidates.push(text)
  for (const raw of candidates) {
    let start = raw.indexOf('{')
    while (start >= 0) {
      // 从 start 起做括号配对，字符串内的花括号不算数
      let depth = 0
      let inString = false
      let escaped = false
      for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i]
        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') {
          inString = true
        } else if (ch === '{') {
          depth += 1
        } else if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            try {
              const parsed = JSON.parse(raw.slice(start, i + 1))
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
            } catch {
              /* 这个起点不是合法 JSON，换下一个 */
            }
            break
          }
        }
      }
      start = raw.indexOf('{', start + 1)
    }
  }
  return null
}

/** 只允许写这些列，其余忽略（避免模型塞进 id/created_at 之类把 INSERT 弄坏）。 */
const LOG_WRITABLE_FIELDS = [
  'title', 'content', 'category', 'date', 'start_time', 'end_time',
  'is_periodic', 'periodic_type', 'periodic_value',
  'reminder_enabled', 'reminder_time', 'advance_minutes',
  'completed', 'color', 'is_task', 'priority', 'status',
]

const LOG_BOOLEAN_FIELDS = ['is_periodic', 'reminder_enabled', 'completed', 'is_task']

const LOG_INTEGER_FIELDS = ['advance_minutes', 'priority']

/** 应用里 status 的实际取值是 pending / in_progress / completed，模型爱写 done / doing，统一一下。 */
const LOG_STATUS_ALIASES = {
  done: 'completed',
  finish: 'completed',
  finished: 'completed',
  已完成: 'completed',
  doing: 'in_progress',
  inprogress: 'in_progress',
  'in-progress': 'in_progress',
  running: 'in_progress',
  进行中: 'in_progress',
  待办: 'pending',
  todo: 'pending',
  open: 'pending',
}

/**
 * 把模型/工具给的字段收敛成后端能接受的类型。
 *
 * 关键点：better-sqlite3 **不接受 JS 布尔值**，会直接抛异常 → 后端返回 500。
 * 应用的 POST 路由自己转 1/0，PUT 路由却是原样透传，所以布尔字段必须在这里转。
 */
function sanitizeLogPayload(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of LOG_WRITABLE_FIELDS) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    if (LOG_BOOLEAN_FIELDS.includes(key)) {
      out[key] = value === false || value === 0 || value === '0' || value === 'false' ? 0 : 1
      continue
    }
    if (LOG_INTEGER_FIELDS.includes(key)) {
      const num = Number(value)
      out[key] = Number.isFinite(num) ? Math.trunc(num) : 0
      continue
    }
    if (key === 'status') {
      const text = String(value).trim()
      out.status = LOG_STATUS_ALIASES[text.toLowerCase()] || LOG_STATUS_ALIASES[text] || text
      continue
    }
    out[key] = typeof value === 'string' ? value : String(value)
  }
  // 允许布尔字段显式写成 false（上面 `value === ''` 跳过不影响 false，因为 false 会走到布尔分支）
  for (const key of LOG_BOOLEAN_FIELDS) {
    if (raw[key] === false) out[key] = 0
  }
  return out
}

/** 把模型给的 ops 收敛成可执行动作；不合法的一律丢弃，最多 5 条。 */
function normalizeOps(parsed) {
  const list = parsed && Array.isArray(parsed.ops) ? parsed.ops : []
  const ops = []
  for (const item of list.slice(0, 5)) {
    if (!item || typeof item !== 'object') continue
    const action = String(item.op || item.action || '').toLowerCase()
    const payload = normalizeFields(item.payload || item.fields || item.log || item)
    if (action === 'create') {
      if (!payload.title || !payload.date) continue
      ops.push({ op: 'create', payload })
    } else if (action === 'update') {
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      if (!id || Object.keys(payload).length === 0) continue
      ops.push({ op: 'update', id, payload })
    } else if (action === 'delete') {
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      if (!id) continue
      ops.push({ op: 'delete', id })
    }
  }
  return ops
}

/** 逐条执行动作；单条失败不影响其余，失败原因原样回给用户。 */
async function executeCalendarOps(ops) {
  const executed = []
  for (const op of ops) {
    diagAppend('host', 'ai-op:start', { op: op.op, id: op.id || null, payload: op.payload || null })
    try {
      if (op.op === 'create') {
        const body = sanitizeLogPayload(op.payload)
        const log = await apiJson('/api/logs', { method: 'POST', body })
        executed.push({ op: 'create', ok: true, log, sql: insertSqlFor(log) })
      } else if (op.op === 'update') {
        const body = sanitizeLogPayload(op.payload)
        if (Object.keys(body).length === 0) {
          executed.push({ op: 'update', ok: false, error: '没有可写入的字段' })
          continue
        }
        const log = await apiJson(`/api/logs/${encodeURIComponent(op.id)}`, { method: 'PUT', body })
        executed.push({ op: 'update', ok: true, log, sql: updateSqlFor(op.id, body) })
      } else {
        await apiJson(`/api/logs/${encodeURIComponent(op.id)}`, { method: 'DELETE' })
        executed.push({ op: 'delete', ok: true, id: op.id, sql: deleteSqlFor(op.id) })
      }
    } catch (err) {
      const message = (err && err.message) || String(err)
      diagAppend('host', 'ai-op:failed', { op: op.op, id: op.id || null, payload: op.payload || null, error: message })
      executed.push({ op: op.op, ok: false, error: message })
    }
  }
  return executed
}

/**
 * 执行结果 → 只在**真的失败**时补一句人话。
 *
 * 成功时不追加任何技术信息：SQL、条数、字段明细都属于实现细节，用户不需要看。
 * 失败时必须说，否则模型会嘴硬说"已安排"，而库里其实什么都没有。
 */
function describeExecution(executed) {
  if (!executed || executed.length === 0) return ''
  const failed = executed.filter((entry) => !entry.ok)
  if (failed.length === 0) return ''
  const reason = String(failed[0].error || '未知原因').replace(/\s+/g, ' ').slice(0, 120)
  return `（这条没能写进日历：${reason}）`
}

/** 模型嘴上说「已创建」但 ops 为空时，兜一句实话。 */
const CLAIM_SUCCESS_RE = /已(?:经)?(?:创建|添加|新建|保存|设置好|修改|更新|删除|完成)/

/**
 * 把整库总结成一段紧凑上下文喂给模型。
 *
 * 目标：让它「知道库里大概有什么、并能定位到具体某一条」，
 * 又不把 token 浪费在倒全部记录上——只保留最近的少量记录及其 id。
 *
 * @param {Array} logs 后端 /api/logs 返回的全部记录（已按日期倒序）
 * @param {{date: string}} now 今天（YYYY-MM-DD）
 * @returns {string} 中文摘要
 */
function buildCalendarDigest(logs, now) {
  const list = Array.isArray(logs) ? logs : []
  const today = now.date
  if (list.length === 0) return '【日历数据】数据库里目前没有任何记录。'

  const isDone = (log) => log.completed === 1 || log.status === 'completed' || log.status === 'done'
  let undone = 0
  let done = 0
  let reminders = 0
  let overdue = 0
  const todays = []
  const upcoming = []
  const recent = []

  for (const log of list) {
    const finished = isDone(log)
    if (finished) done += 1
    else undone += 1
    if (log.reminder_enabled) reminders += 1
    if (!finished && log.date && log.date < today) overdue += 1

    const label = `${log.date || ''} ${log.start_time || ''} ${log.title || ''}`.replace(/\s+/g, ' ').trim()
    const flags = []
    if (log.reminder_enabled) flags.push(`提醒${log.reminder_time || ''}`)
    if (log.is_task) flags.push('任务')
    flags.push(finished ? '已完成' : String(log.status || 'pending'))
    const brief = `${label} [${flags.join('/')}]`

    if (log.date === today) todays.push(brief)
    if (log.date && log.date > today) upcoming.push(brief)
    if (recent.length < 10) recent.push(`- id=${log.id} | ${brief}`)
  }

  const head = `【日历数据概览】共 ${list.length} 条｜未完成 ${undone} / 已完成 ${done}｜开启提醒 ${reminders} 条`
    + (overdue > 0 ? `｜已过期未完成 ${overdue} 条` : '')
  const lines = [
    head,
    `今天（${today}）：${todays.length > 0 ? todays.slice(0, 6).join('；') : '无记录'}`,
  ]
  if (upcoming.length > 0) lines.push(`之后：${upcoming.slice(0, 6).join('；')}`)
  lines.push('')
  lines.push('最近的记录（update / delete 用这里的 id）：')
  lines.push(recent.length > 0 ? recent.join('\n') : '- 无')
  if (list.length > recent.length) {
    lines.push(`（另有 ${list.length - recent.length} 条更早的记录未列出；用户指的若是它们，请让用户描述得更具体）`)
  }
  return lines.join('\n')
}

/**
 * 日历面板里的一轮对话：解析动作 → 真的落库 → 返回事实化的回复。
 * @param {{ history: string, contextLogs: string }} input 已拼好的对话历史与上下文日志
 */
async function chatWithCalendarActions({ history, contextLogs }) {
  const now = calendarNow()
  let modelName = 'deepseek-flash'
  try {
    const llm = getLlm()
    if (llm) modelName = (await resolveLlmRoute(llm)).model
  } catch {
    /* 路由解析失败就用默认名，不影响建任务 */
  }

  // 把数据库总结成一段紧凑的上下文喂给模型，而不是倒原始列表。
  // 摘要里保留少量近期记录的 id，够它把「删除它 / 标记完成」落到具体某一条。
  let dbDigest = ''
  try {
    const all = await apiJson('/api/logs')
    dbDigest = buildCalendarDigest(all, now)
  } catch (err) {
    diagAppend('host', 'chat:digest-failed', String((err && err.message) || err))
  }

  const system = [
    '你是「AI 智能日历」里的助手，可以直接读写这台电脑上的日历数据库。',
    `今天是 ${now.date}（${now.weekday}），现在 ${now.time}。用户说「今天/明天/后天/下周一」时，按这个换算成 YYYY-MM-DD。`,
    '',
    '数据库表 logs 的字段：',
    '- title 标题（必填）、date 日期 YYYY-MM-DD（必填）、content 正文或备注',
    '- category 分类：meeting / task / chore / personal / work / study / health / other',
    '- start_time、end_time 时间 HH:mm',
    '- reminder_enabled 是否提醒（布尔）、reminder_time 提醒时间 HH:mm、advance_minutes 提前多少分钟（整数）',
    '- is_task 是否作为任务（布尔）、priority 优先级整数、status pending / in_progress / completed、completed 是否完成（布尔）',
    '- color 颜色、is_periodic 是否周期（布尔）、periodic_type daily / workday / weekend / weekly / monthly、periodic_value 周几或几号',
    '',
    '你的整段回答必须是**一个 JSON 对象**，前面后面都不要有别的话：',
    '{"reply":"给用户看的中文回复","ops":[{"op":"create","payload":{"title":"...","date":"YYYY-MM-DD"}}]}',
    '可用动作：',
    '- {"op":"create","payload":{...}} 新增日志或任务',
    '- {"op":"update","id":"记录id","payload":{...}} 只改要改的字段',
    '- {"op":"delete","id":"记录id"} 删除',
    '',
    '规则：',
    '1. 用户要求新建、修改、删除日程或任务时，把动作放进 ops，插件会真的执行并追回执行结果。',
    '2. ops 为空数组表示不改数据库。不要在 reply 里声称已经创建/修改/删除——执行结果由插件追加。',
    '3. 改、删必须有 id。id 只能从上面「日历数据概览」的近期记录里取，不要自己编。',
    '   用户说「删除它 / 标记完成 / 改一下」时，优先匹配对话里刚提到的那条（标题或时间最接近的），'
      + '直接给出对应 id 的 ops；不要回复"看不到记录"或"请提供 id"——摘要里就有。',
    '   只有摘要里确实找不到对应记录时，才在 reply 里问清楚是哪一条。',
    '4. 用户问「你是什么模型」时，在 reply 里写「我用的是 DeepSeek 的 ' + modelName + '」，不要提 provider 或参数。',
    '5. reply 用纯文本，不要 Markdown、星号、反引号、井号标题，200 字以内。',
    '6. 提醒按用户原话算 advance_minutes；用户没提提醒就不要自己编提醒时间。',
  ].join('\n')

  const prompt = [
    dbDigest || '【日历数据】数据库里目前没有任何记录。',
    '',
    contextLogs ? `前端附带的上下文（可能与上面重复，无需转述）：\n${contextLogs}\n` : '',
    '对话：',
    history,
    '',
    '只输出那一个 JSON 对象。',
  ].filter((part) => part !== null).join('\n')

  let parsed = null
  let result = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    result = await askModel({
      system: attempt === 0 ? system : `${system}\n\n注意：上一次输出不是合法 JSON。这次只输出 JSON 对象本身，不要任何解释文字、不要代码围栏。`,
      prompt,
      maxTokens: 900,
    })
    parsed = extractJsonObject(result.text)
  }

  const ops = parsed ? normalizeOps(parsed) : []
  const executed = ops.length > 0 ? await executeCalendarOps(ops) : []

  let reply
  if (parsed) {
    const spoken = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
    reply = [spoken, describeExecution(executed)].filter(Boolean).join('\n')
  } else {
    const raw = result && typeof result.text === 'string' ? result.text.trim() : ''
    reply = ['（模型没有按约定返回可执行结构，本次未改动数据库）', raw].filter(Boolean).join('\n')
  }
  if (executed.length === 0 && CLAIM_SUCCESS_RE.test(reply)) {
    reply += '\n（提示：本次没有产生数据库写入，上面的说法只是建议；要真正保存请明确说「创建」或点面板上的保存按钮。）'
  }

  return {
    reply,
    executed,
    sql: executed.map((entry) => entry.sql).filter(Boolean),
    usage: result ? result.usage : null,
    cost: result ? result.cost : null,
    provider: result ? result.provider : null,
    model: result ? result.model : null,
  }
}

async function handleAiRoute(req, res, pathname) {
  const sub = pathname.slice(API_PREFIX.length) // 形如 /ai/classify
  if (!sub.startsWith('/ai/')) return false

  const action = sub.slice('/ai/'.length).replace(/\/+$/, '')
  const method = String(req.method || 'GET').toUpperCase()

  try {
    if (action === 'config') {
      if (method === 'POST') {
        await readJsonBody(req)
        sendJson(res, 200, { success: true })
        return true
      }
      const llm = getLlm()
      let model = process.env.DSH_CALENDAR_AI_MODEL || 'deepseek'
      let provider = 'deepseek'
      try {
        if (llm) {
          const route = await resolveLlmRoute(llm)
          model = route.model
          provider = route.provider
        }
      } catch {
        /* 路由解析失败也返回一个可用形状，让应用走后续调用时报具体错误 */
      }
      sendJson(res, 200, {
        // 注意：应用用 PROVIDER_NAMES[provider] 取显示名，只认 deepseek/openai/... 这些
        // 短 key。DSH 的路由名是 "deepseek-official"，直接透回去会取不到名字、
        // 回退成 "AI"，界面就显示成「连接 AI AI…」。这里统一回 canonical key。
        provider: /deepseek/i.test(provider) ? 'deepseek' : provider,
        providerRoute: provider,
        model,
        enabled: true,
        keys: {},
        managedBy: 'dsh-ai-calendar',
      })
      return true
    }

    if (action === 'providers') {
      sendJson(res, 200, { models: [], needsApiKey: {} })
      return true
    }

    if (action === 'history') {
      if (method === 'DELETE') sendJson(res, 200, { success: true })
      else sendJson(res, 200, [])
      return true
    }

    if (action === 'usage') {
      let route = null
      try {
        const llm = getLlm()
        route = llm ? await resolveLlmRoute(llm) : null
      } catch {
        /* 路由不可用时也给出计费口径 */
      }
      sendJson(res, 200, {
        stats: aiStats,
        pricing: {
          currency: 'CNY',
          estimated: true,
          inputPerMillionRmb: PRICE_INPUT_PER_M,
          outputPerMillionRmb: PRICE_OUTPUT_PER_M,
        },
        route,
        provider: route ? route.provider : null,
        model: route ? route.model : null,
        notice: 'AI 由 DeepSeek Harness 提供，调用的是 DeepSeek API，按 token 计费（需付费）。',
      })
      return true
    }

    if (action === 'classify') {
      const body = await readJsonBody(req)
      const result = await classifyLog(body.title, body.content)
      sendJson(res, 200, { category: result.category, priority: 0, cost: result.cost })
      return true
    }

    if (action === 'chat') {
      const body = await readJsonBody(req)
      const messages = Array.isArray(body.messages) ? body.messages : []
      const contextLogs = typeof body.contextLogs === 'string' ? body.contextLogs : ''
      const history = messages
        .slice(-12)
        .map((message) => `${message.role === 'assistant' ? '助手' : '用户'}：${messageText(message)}`)
        .join('\n')
      const chat = await chatWithCalendarActions({ history, contextLogs })
      sendJson(res, 200, {
        reply: chat.reply,
        executed: chat.executed,
        sql: chat.sql,
        usage: chat.usage,
        cost: chat.cost,
        provider: chat.provider,
        model: chat.model,
      })
      return true
    }

    if (action === 'summary') {
      const body = await readJsonBody(req)
      const logs = Array.isArray(body.logs) ? body.logs : []
      const lines = logs.map((log) => `- ${log.date || ''} ${log.start_time || ''} ${log.title || ''} ${log.completed ? '(已完成)' : ''}`.trim())
      const prompt = [
        `请为 ${body.type || '日志'} ${body.date || ''} 生成一段简洁总结：`,
        lines.join('\n') || '（这天没有记录）',
        '',
        '要求：中文，200 字以内，指出重点与待办，不要客套话。',
      ].join('\n')
      const result = await askModel({
        system: '你是日历日志的总结助手。',
        prompt,
        maxTokens: 600,
      })
      sendJson(res, 200, {
        summary: result.text,
        usage: result.usage,
        cost: result.cost,
        provider: result.provider,
        model: result.model,
      })
      return true
    }

    if (action === 'task-parse') {
      // 应用的 AI 面板已隐藏，这里只保证接口形状可用，不再做自然语言建任务。
      await readJsonBody(req)
      sendJson(res, 200, {
        is_task: false,
        reply: '自然语言建任务已交给 DeepSeek Harness 的对话（calendar_create_log 工具）。',
      })
      return true
    }

    sendJson(res, 404, { error: `未接管的 AI 子路由：${action}` })
    return true
  } catch (err) {
    const message = (err && err.message) || String(err)
    // classify 失败不能让前端保存流程报错：回落到 other
    if (action === 'classify') {
      sendJson(res, 200, { category: 'other', priority: 0, error: message })
      return true
    }
    sendJson(res, 500, { error: message })
    return true
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** clientModules 服务的访问器（可选服务，由 apply 注入）。 */
let getClientModules = () => null

/** 自检：client 模块图里有没有本插件、bundle 路径是否存在。 */
function selfCheck() {
  const out = { diagFile: DIAG_FILE, rowId: 'dsh-ai-calendar', graph: null, clientPath: null, bundleExists: null, error: null }
  try {
    const clientModules = getClientModules()
    if (!clientModules) {
      out.error = 'clientModules 服务不可用'
      return out
    }
    try {
      const graph = typeof clientModules.graph === 'function' ? clientModules.graph() : null
      out.graph = graph
        ? {
            rev: graph.rev,
            entries: (graph.entries || []).map((e) => ({ id: e.id, url: e.url, rev: e.rev, inject: e.inject, immediately: e.immediately })),
            batches: (graph.batches || []).map((b) => ({ phase: b.phase, entries: b.entries })),
          }
        : null
    } catch (err) {
      out.error = `graph(): ${(err && err.message) || err}`
    }
    try {
      out.clientPath = (typeof clientModules.clientPath === 'function' ? clientModules.clientPath('dsh-ai-calendar') : null) || null
    } catch (err) {
      out.clientPathError = (err && err.message) || String(err)
    }
    if (out.clientPath) out.bundleExists = fs.existsSync(out.clientPath)
  } catch (err) {
    out.error = (err && err.message) || String(err)
  }
  return out
}

/**
 * 本地时区口径的「到点提醒」。
 *
 * 应用自己的 /api/reminders/check 用 `new Date().toISOString()` 取「今天」，
 * 那是 UTC 日期——在 UTC+8 的凌晨 00:00~07:59 会算成前一天，
 * 导致当天的提醒被整段过滤掉、永远不弹。这里用本地日期重算。
 */
function matchesPeriodicLocal(log, dateStr) {
  const type = String(log.periodic_type || '')
  const value = String(log.periodic_value || '')
  const date = new Date(`${dateStr}T00:00:00`)
  const dow = date.getDay()
  switch (type) {
    case 'daily': return true
    case 'workday': return dow >= 1 && dow <= 5
    case 'weekend': return dow === 0 || dow === 6
    case 'weekly': {
      const map = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
      return map[value] === dow
    }
    case 'monthly': return String(date.getDate()) === value
    default: return false
  }
}

async function dueRemindersLocal() {
  const all = await apiJson('/api/logs')
  const list = Array.isArray(all) ? all : []
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  return list.filter((log) => {
    if (!log.reminder_enabled || !log.reminder_time) return false
    if (log.completed === 1 || log.status === 'completed') return false
    if (log.is_periodic === 1) {
      if (!matchesPeriodicLocal(log, today)) return false
    } else if (log.date !== today) {
      return false
    }
    const [hour, minute] = String(log.reminder_time).split(':').map(Number)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
    const dueAt = hour * 60 + minute - (Number(log.advance_minutes) || 0)
    return dueAt >= 0 && dueAt <= nowMinutes
  })
}

function routes() {
  return [
    {
      kind: 'exact',
      path: `${ROUTE_ROOT}/log`,
      async handler(req, res) {
        try {
          const text = await readBody(req, 256 * 1024)
          diagAppend('client', 'entry', text)
        } catch (err) {
          diagAppend('client', 'entry-read-failed', String(err))
        }
        res.statusCode = 204
        res.setHeader('cache-control', 'no-store')
        res.end()
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_ROOT}/selfcheck`,
      handler(_req, res) {
        const result = selfCheck()
        diagAppend('host', 'selfcheck', result)
        sendJson(res, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_ROOT}/status`,
      async handler(_req, res) {
        const running = await probeHealth()
        let ai = null
        try {
          const llm = getLlm()
          ai = llm ? await resolveLlmRoute(llm) : null
        } catch (err) {
          ai = { error: (err && err.message) || String(err) }
        }
        sendJson(res, 200, {
          running,
          build: 'v1.2.0-chat-actions',
          port: BACKEND_PORT,
          backend: `http://${BACKEND_HOST}:${BACKEND_PORT}/`,
          app: `${APP_PREFIX}/`,
          projectRoot: PROJECT_ROOT,
          dist: DIST_DIR,
          entry: backendEntryFile() || null,
          spawnedByHost: Boolean(backendChild),
          lastStartError: lastStartError || null,
          lastStartVia: lastStartVia || null,
          ai,
        })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_ROOT}/ensure`,
      async handler(req, res) {
        const site = String((req.headers && req.headers['sec-fetch-site']) || '')
        if (site === 'cross-site') {
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        if (req.method && !['GET', 'POST', 'HEAD'].includes(req.method.toUpperCase())) {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const result = await ensureBackend()
        sendJson(res, result.running ? 200 : 503, result)
      },
    },
    {
      kind: 'prefix',
      path: APP_PREFIX,
      handler(req, res) {
        let pathname = '/'
        try {
          pathname = new URL(req.url, 'http://localhost').pathname
        } catch {
          sendText(res, 400, 'bad request')
          return
        }
        serveApp(req, res, pathname)
      },
    },
    {
      kind: 'prefix',
      path: API_PREFIX,
      async handler(req, res) {
        let parsed
        try {
          parsed = new URL(req.url, 'http://localhost')
        } catch {
          sendJson(res, 400, { error: 'bad request' })
          return
        }
        // 提醒检查用本地时区重算（应用原实现取 UTC 日期，凌晨会漏掉当天提醒）
        if (parsed.pathname === `${API_PREFIX}/reminders/check`) {
          try {
            const due = await dueRemindersLocal()
            sendJson(res, 200, due)
          } catch (err) {
            sendJson(res, 503, { error: (err && err.message) || String(err) })
          }
          return
        }
        // 先看是不是 AI 接管；不是就原样反代到应用后端。
        const handled = await handleAiRoute(req, res, parsed.pathname)
        if (handled) return
        proxyToBackend(req, res, parsed.pathname, parsed.search)
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Agent 工具
// ---------------------------------------------------------------------------

const LOG_FIELD_PROPS = {
  content: { type: 'string', description: '正文 / 备注，纯文本或 Markdown。' },
  category: { type: 'string', description: '分类：meeting / task / chore / personal / work / study / health / other。' },
  start_time: { type: 'string', description: '开始时间 HH:mm。' },
  end_time: { type: 'string', description: '结束时间 HH:mm。' },
  is_periodic: { type: 'boolean', description: '是否为周期性日志（每日/每周/每月等）。' },
  periodic_type: {
    type: 'string',
    description: '周期类型：daily / workday / weekend / weekly / monthly。',
    enum: ['daily', 'workday', 'weekend', 'weekly', 'monthly'],
  },
  periodic_value: { type: 'string', description: '周期取值：weekly 用「一~日」，monthly 用几号。' },
  reminder_enabled: { type: 'boolean', description: '是否开启提醒。' },
  reminder_time: { type: 'string', description: '提醒时间 HH:mm。' },
  advance_minutes: { type: 'integer', description: '提前多少分钟提醒。' },
  completed: { type: 'boolean', description: '是否已完成。' },
  color: { type: 'string', description: '自定义颜色，例如 #4f8cff。' },
  is_task: { type: 'boolean', description: '是否作为任务（出现在任务面板）。' },
  priority: { type: 'integer', description: '优先级，数字越大越靠前。' },
  status: { type: 'string', description: '任务状态，例如 pending / doing / done。' },
}

function logOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      log: { type: 'object', additionalProperties: true },
      error: { type: 'string' },
    },
  }
}

function formatLogLine(log) {
  if (!log || typeof log !== 'object') return '- (无效记录)'
  const when = [log.date, log.start_time && log.end_time ? `${log.start_time}-${log.end_time}` : log.start_time]
    .filter(Boolean)
    .join(' ')
  const bits = [when, log.title].filter(Boolean).join('  ')
  const extra = []
  if (log.is_task) extra.push('任务')
  if (log.is_periodic) extra.push(`周期:${log.periodic_type || ''}`)
  if (log.status) extra.push(String(log.status))
  if (log.completed) extra.push('已完成')
  if (log.category) extra.push(String(log.category))
  return `- ${bits}${extra.length ? `  [${extra.join(' / ')}]` : ''}`
}

function registerTools(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'calendar_status',
    description: '检查「AI 智能日历」后端是否在线，并返回端口、路径、日志总数，以及接管后的 AI 路由（provider/model）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'boolean' },
          port: { type: 'number' },
          url: { type: 'string' },
          projectRoot: { type: 'string' },
          totalLogs: { type: 'number' },
          aiProvider: { type: 'string' },
          aiModel: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.running) {
          return [{ type: 'text', text: `日历后端不可用：${value.error || '未知原因'}` }]
        }
        return [{
          type: 'text',
          text: `日历后端在线：${value.url}（端口 ${value.port}），当前日志 ${value.totalLogs ?? '?'} 条；`
            + `AI 走 ${value.aiProvider || '?'}/${value.aiModel || '?'}。`,
        }]
      },
    },
    async execute() {
      const health = await ensureBackend()
      let totalLogs
      if (health.running) {
        try {
          const logs = await apiJson('/api/logs')
          totalLogs = Array.isArray(logs) ? logs.length : undefined
        } catch {
          /* 统计失败不影响可用性结论 */
        }
      }
      let aiProvider
      let aiModel
      try {
        const llm = getLlm()
        if (llm) {
          const route = await resolveLlmRoute(llm)
          aiProvider = route.provider
          aiModel = route.model
        }
      } catch {
        /* AI 路由不可用不影响后端结论 */
      }
      const value = {
        running: Boolean(health.running),
        port: BACKEND_PORT,
        url: `http://${BACKEND_HOST}:${BACKEND_PORT}/`,
        projectRoot: PROJECT_ROOT,
      }
      if (totalLogs !== undefined) value.totalLogs = totalLogs
      if (aiProvider) value.aiProvider = aiProvider
      if (aiModel) value.aiModel = aiModel
      if (!health.running) value.error = health.error || 'backend not running'
      return value
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_list_logs',
    description: '查询「AI 智能日历」的日志/任务。可按日期区间、是否周期性、是否任务过滤；返回按日期倒序的记录列表。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: 'string', description: '起始日期 YYYY-MM-DD（含）。' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD（含）。' },
        date: { type: 'string', description: '只看某一天 YYYY-MM-DD（等价于 start=end）。' },
        periodic: { type: 'boolean', description: '只看周期性日志。' },
        is_task: { type: 'boolean', description: '只看任务。' },
        limit: { type: 'integer', description: '最多返回多少条，默认 50，最大 500。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          returned: { type: 'number' },
          logs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render(_args, value) {
        const logs = Array.isArray(value.logs) ? value.logs : []
        if (logs.length === 0) return [{ type: 'text', text: `没有匹配的日历记录（总计 ${value.total ?? 0} 条）。` }]
        const lines = logs.map(formatLogLine)
        return [{
          type: 'text',
          text: `共 ${value.total ?? logs.length} 条，显示 ${logs.length} 条：\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args) {
      const query = new URLSearchParams()
      const start = args.date || args.start
      const end = args.date || args.end
      if (start) query.set('start', start)
      if (end) query.set('end', end)
      if (args.periodic) query.set('periodic', '1')
      if (args.is_task) query.set('is_task', '1')
      const logs = await apiJson(`/api/logs${query.size ? `?${query}` : ''}`)
      const list = Array.isArray(logs) ? logs : []
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500)
      return { total: list.length, returned: Math.min(limit, list.length), logs: list.slice(0, limit) }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_create_log',
    description: '在「AI 智能日历」里新增一条日志或任务。title 与 date 必填；周期性日志请设置 is_periodic + periodic_type(+periodic_value)。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '标题（必填）。' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（必填）。' },
        ...LOG_FIELD_PROPS,
      },
      required: ['title', 'date'],
    },
    output: {
      schema: logOutputSchema(),
      render(_args, value) {
        if (value.ok && value.log) return [{ type: 'text', text: `已创建：${formatLogLine(value.log).slice(2)}` }]
        return [{ type: 'text', text: `创建失败：${value.error || '未知错误'}` }]
      },
    },
    async execute(args) {
      const payload = {}
      for (const key of Object.keys(LOG_FIELD_PROPS)) {
        if (args[key] !== undefined) payload[key] = args[key]
      }
      const log = await apiJson('/api/logs', {
        method: 'POST',
        body: sanitizeLogPayload({ ...payload, title: args.title, date: args.date }),
      })
      return { ok: true, log }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_update_log',
    description: '修改「AI 智能日历」里已有的一条日志/任务。只需传 id 和要改的字段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记录 id（UUID，可用 calendar_list_logs 查到）。' },
        title: { type: 'string', description: '新标题。' },
        date: { type: 'string', description: '新日期 YYYY-MM-DD。' },
        ...LOG_FIELD_PROPS,
      },
      required: ['id'],
    },
    output: {
      schema: logOutputSchema(),
      render(_args, value) {
        if (value.ok && value.log) return [{ type: 'text', text: `已更新：${formatLogLine(value.log).slice(2)}` }]
        return [{ type: 'text', text: `更新失败：${value.error || '未知错误'}` }]
      },
    },
    async execute(args) {
      const { id, ...rest } = args
      const body = sanitizeLogPayload(rest)
      if (Object.keys(body).length === 0) {
        throw new Error('没有可更新的字段')
      }
      const log = await apiJson(`/api/logs/${encodeURIComponent(id)}`, { method: 'PUT', body })
      return { ok: true, log }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_delete_log',
    description: '删除「AI 智能日历」里的一条日志/任务。这是不可撤销的操作，调用前请确认 id 正确。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记录 id（UUID）。' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.ok ? `已删除记录 ${value.id}` : `删除失败：${value.error || '未知错误'}` }]
      },
    },
    async execute(args) {
      await apiJson(`/api/logs/${encodeURIComponent(args.id)}`, { method: 'DELETE' })
      return { ok: true, id: args.id }
    },
  }))

  // 数据互通 + 真的调 DeepSeek：读真实日志，交给 DSH 的模型总结
  disposers.push(ctx.tools.register({
    name: 'calendar_summarize',
    description: '读取指定日期区间的真实日历日志，调用 DSH 已配置的 DeepSeek 生成一段中文总结（重点与待办）。用于「今天/本周都干了什么」这类问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '只看某一天 YYYY-MM-DD。' },
        start: { type: 'string', description: '起始日期 YYYY-MM-DD。' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number' },
          summary: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.error) return [{ type: 'text', text: `总结失败：${value.error}` }]
        return [{
          type: 'text',
          text: `${value.summary}\n\n（基于 ${value.count} 条记录，由 ${value.provider}/${value.model} 生成）`,
        }]
      },
    },
    async execute(args) {
      const query = new URLSearchParams()
      const start = args.date || args.start
      const end = args.date || args.end
      if (start) query.set('start', start)
      if (end) query.set('end', end)
      const logs = await apiJson(`/api/logs${query.size ? `?${query}` : ''}`)
      const list = Array.isArray(logs) ? logs : []
      if (list.length === 0) {
        return { count: 0, summary: '这个区间没有任何日历记录。', provider: '', model: '' }
      }
      const lines = list.slice(0, 120).map(formatLogLine)
      const result = await askModel({
        system: '你是日历日志的总结助手，输出简洁中文。',
        prompt: [
          `请总结这段时间的日历记录（共 ${list.length} 条）：`,
          lines.join('\n'),
          '',
          '要求：中文，300 字以内，先给重点，再给明确的待办/风险，不要客套话。',
        ].join('\n'),
        maxTokens: 900,
      })
      return {
        count: list.length,
        summary: result.text,
        provider: result.provider,
        model: result.model,
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'ai-calendar',

  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      // 注意：**不在这里 killBackend()**。
      // 插件每次热重载都会走一次 dispose → 若同时杀后端并重新拉起，
      // 会有一段时间两个进程抢同一个 SQLite，写入直接 500（"Internal Server Error"）。
      // 后端生命周期与 DSH 进程绑定：进程退出时子进程随之结束，无需这里收尾。
      diagAppend('host', 'apply:dispose', { keptBackend: Boolean(backendChild) })
    })

    root.inject(['webServer'], (ctx) => {
      // llm 是可选服务：没有它时只影响 AI 接管，面板与工具照常工作。
      try {
        getLlm = () => (typeof ctx.get === 'function' ? ctx.get('llm') : null)
      } catch {
        getLlm = () => null
      }
      try {
        getClientModules = () => (typeof ctx.get === 'function' ? ctx.get('clientModules') : null)
      } catch {
        getClientModules = () => null
      }
      diagAppend('host', 'apply:mounted', {
        diagFile: DIAG_FILE,
        routes: routes().map((route) => `${route.kind}:${route.path}`),
        packageRoot: PACKAGE_ROOT,
      })

      ctx.effect(() => {
        const cleanup = []
        for (const route of routes()) {
          cleanup.push(ctx.webServer.register(route))
        }
        return () => {
          for (const dispose of cleanup) {
            try {
              dispose()
            } catch {
              /* ignore */
            }
          }
        }
      }, 'ai-calendar: routes')
    })

    root.inject(['tools'], (ctx) => {
      ctx.effect(() => registerTools(ctx), 'ai-calendar: tools')
    })

    const warmup = setTimeout(() => {
      ensureBackend()
        .then((result) => {
          if (!result.running) {
            console.warn(`[ai-calendar] 后端未能拉起：${result.error || '未知原因'}`)
          }
        })
        .catch(() => {})
    }, 2000)
    disposers.push(() => clearTimeout(warmup))
  },
}

export const inject = []
