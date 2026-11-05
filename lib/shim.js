/* dsh-ai-calendar —— 注入到「同源托管」日历页面的 shim
 *
 * 由 host 在 /dsh-calendar/app/index.html 里前置注入（普通脚本，早于应用的 module 执行）：
 *   1. 把应用发的 /api/* 改写到 /dsh-calendar/api/*（由 host 反代到 3001，AI 路由被接管）
 *   2. 跟随 DSH 主题：写 localStorage.theme_mode，并同步 data-theme-mode
 *   3. 隐藏应用自带的「AI 助手」入口（悬浮按钮 + 左侧导航项）
 *
 * 这个文件是每次请求现读的，改完只要刷新页面，不用重启 DSH。
 */
(function () {
  'use strict'

  if (window.__dshCalendarShim) return
  window.__dshCalendarShim = true

  var ROUTE_ROOT = '/dsh-calendar'

  // ---- 0. 早期错误捕获 ----------------------------------------------------
  // 本文件在应用的 module 脚本之前执行，所以能抓到启动期异常与资源加载失败。
  var LOG_URL = ROUTE_ROOT + '/log'

  function report(event, detail) {
    try {
      var payload = { event: 'app:' + event, at: new Date().toISOString(), href: location.href }
      if (detail !== undefined) {
        try {
          payload.detail = typeof detail === 'string' ? detail : JSON.stringify(detail)
        } catch (err) {
          payload.detail = String(detail)
        }
      }
      var text = JSON.stringify(payload)
      // 只用 fetch(keepalive)：sendBeacon 在 no-cors 模式下会被宿主安全栅栏静默丢弃，
      // 而且它返回 true，导致后面的 fetch 兜底永远不执行 —— 日志与标注都因此消失过。
      fetch(LOG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
        keepalive: true,
      }).catch(function () {})
    } catch (err) {
      /* ignore */
    }
  }

  report('shim-ready', { base: document.baseURI })

  window.addEventListener('error', function (event) {
    try {
      var target = event && event.target
      if (target && target !== window && target.tagName) {
        report('resource-error', { tag: String(target.tagName), url: String(target.src || target.href || '') })
        return
      }
      report('error', String((event && event.message) || event)
        + ' @ ' + String((event && event.filename) || '')
        + ':' + String((event && event.lineno) || 0)
        + ':' + String((event && event.colno) || 0))
    } catch (err) {
      /* ignore */
    }
  }, true)

  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event && event.reason
      report('rejection', String((reason && (reason.stack || reason.message)) || reason))
    } catch (err) {
      /* ignore */
    }
  })

  window.addEventListener('DOMContentLoaded', function () {
    try {
      var root = document.getElementById('root')
      var scripts = []
      for (var i = 0; i < document.scripts.length; i++) {
        scripts.push(document.scripts[i].src ? document.scripts[i].src : '(inline)')
      }
      // 每个前端资源实际取回来多少字节：能直接区分 404 / 空响应 / 正常
      var resources = []
      try {
        var entries = performance.getEntriesByType('resource')
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j]
          if (String(entry.name).indexOf('/dsh-calendar/app/') < 0) continue
          resources.push({
            name: String(entry.name).split('/dsh-calendar/app/')[1] || '',
            bytes: entry.decodedBodySize,
            ms: Math.round(entry.duration),
          })
        }
      } catch (err) {
        /* ignore */
      }
      report('dom-ready', {
        rootChildren: root ? root.childElementCount : -1,
        base: document.baseURI,
        scripts: scripts,
        resources: resources,
      })
    } catch (err) {
      /* ignore */
    }
  })


  // ---- 1. API 改写 --------------------------------------------------------
  function rewriteUrl(url) {
    if (typeof url !== 'string') return url
    if (url.indexOf(ROUTE_ROOT + '/') === 0) return url
    if (url.indexOf('/api') === 0) {
      // '/api'、'/api/x'、'/api?x' 都覆盖
      if (url === '/api' || url.indexOf('/api/') === 0 || url.indexOf('/api?') === 0) {
        return ROUTE_ROOT + url
      }
    }
    return url
  }

  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var seenUrl = typeof input === 'string' ? input : (input && input.url) || ''
      try {
        if (typeof input === 'string') {
          input = rewriteUrl(input)
        } else if (input && typeof input.url === 'string') {
          var next = rewriteUrl(input.url)
          if (next !== input.url) input = new Request(next, input)
        }
      } catch (err) {
        /* 改写失败就走原来的请求 */
      }
      // 给对话请求注入「运行信息」，让模型能正确回答"你是什么模型"
      // （宿主侧系统提示也会加，但这里保证旧版宿主下也立刻生效）
      try {
        if (String(seenUrl).indexOf('/api/ai/chat') >= 0 && init && typeof init.body === 'string') {
          var payload = JSON.parse(init.body)
          if (payload && Array.isArray(payload.messages)) {
            var route = aiRouteCache || {}
            var preamble = '（背景：你运行在 DeepSeek Harness 中，背后调用 DeepSeek API，当前模型为 '
              + (route.model || 'deepseek-flash') + '，按 token 计费。'
              + '用户问到你用的是什么模型时，用一句自然的中文回答即可，例如「我用的是 DeepSeek 的 '
              + (route.model || 'deepseek-flash') + '」。'
              + '不要输出 provider、反引号、星号等技术细节，不要道歉，也不要解释你是怎么知道的。'
              + '这个界面不渲染 Markdown，请用纯文本回答，不要使用星号、反引号或井号标题。'
              + '你没有数据库/SQL/文件写入权限：绝对不要声称“已写入”或“已保存到数据库”，'
              + '也不要编造 SQL、执行结果、表结构或报错页面；用户要新建日程时，'
              + '如实说明这里只能给建议，让他直接在日历界面添加，或到 DeepSeek Harness 的对话里用日历工具写入。）'
            payload.messages = [{ role: 'user', content: preamble }].concat(payload.messages)
            init = Object.assign({}, init, { body: JSON.stringify(payload) })
          }
        }
      } catch (err) {
        /* 注入失败不影响原请求 */
      }
      var result = nativeFetch.call(this, input, init)
      // AI 调用返回后，在最新一条助手气泡下方标注「模型版本 + tokens + 人民币」
      try {
        if (String(seenUrl).indexOf('/api/ai/') >= 0 && result && typeof result.then === 'function') {
          result = result.then(function (res) {
            try {
              res.clone().json().then(function (data) {
                if (!data) return
                recordUsage(data.cost)
                annotateLastReply(data)
                refreshCalendarViewIfWrote(data)
              }).catch(function () {})
            } catch (err) {
              /* ignore */
            }
            return res
          })
        }
      } catch (err) {
        /* ignore */
      }
      return result
    }
  }

  // XMLHttpRequest 兜底（当前前端只用 fetch，留着以防以后改动）
  try {
    var open = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments)
      args[1] = rewriteUrl(url)
      return open.apply(this, args)
    }
  } catch (err) {
    /* ignore */
  }

  // ---- 2. 主题：默认浅色 --------------------------------------------------
  // 只在「从未初始化过」时强制一次浅色；之后尊重应用内手动切换（点太阳/月亮）。
  function applyDefaultLightTheme() {
    var FORCED_FLAG = 'dsh_light_default_v1'
    try {
      if (localStorage.getItem(FORCED_FLAG) === '1') return
      localStorage.setItem('theme_mode', 'light')
      localStorage.setItem(FORCED_FLAG, '1')
    } catch (err) {
      /* 隐私模式等拿不到 localStorage 时，至少把当前文档设成浅色 */
    }
    try {
      document.documentElement.setAttribute('data-theme-mode', 'light')
    } catch (err) {
      /* ignore */
    }
  }

  applyDefaultLightTheme()

  // ---- 3. 隐藏应用自带的 AI 助手 ------------------------------------------
  function installAiHider() {
    if (document.getElementById('dsh-ai-calendar-hide-ai')) return
    var style = document.createElement('style')
    style.id = 'dsh-ai-calendar-hide-ai'
    style.textContent = [
      // 两处 AI 悬浮按钮（timeline 与 calendar 两套布局各有一个）
      '.ai-fab{display:none!important}',
      // 左侧导航里的「AI 助手」项
      '.left-nav-item[title="AI 助手"]{display:none!important}',
      // AI 面板容器（万一被其它路径打开）
      '.ai-panel, .ai-panel-overlay, .ai-drawer{display:none!important}',
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  // ---- 在「主题设置」里注入悬浮窗开关 --------------------------------------
  var WIDGET_STATE_KEY = 'dsh_ai_calendar_widget_v1'

  function readWidgetHidden() {
    try {
      var raw = localStorage.getItem(WIDGET_STATE_KEY)
      var st = raw ? JSON.parse(raw) : null
      return Boolean(st && st.hidden)
    } catch (err) {
      return false
    }
  }

  function writeWidgetHidden(hidden) {
    try {
      var raw = localStorage.getItem(WIDGET_STATE_KEY)
      var st = raw ? JSON.parse(raw) : null
      if (!st || typeof st !== 'object') st = {}
      st.hidden = Boolean(hidden)
      localStorage.setItem(WIDGET_STATE_KEY, JSON.stringify(st))
    } catch (err) {
      /* ignore */
    }
    // 直接在父窗口（Harness 页面）上调用，同源所以可用
    try {
      var api = window.parent && window.parent.__dshCalendarWidget
      if (api && typeof api.setHidden === 'function') api.setHidden(Boolean(hidden))
    } catch (err) {
      /* 父窗口还没就绪：只写存储，等浮窗下次读取 */
    }
  }

  function injectWidgetToggle() {
    try {
      var title = document.querySelector('.page-title')
      if (!title || String(title.textContent || '').trim() !== '主题设置') return
      if (document.getElementById('dsh-widget-toggle')) return

      var labels = document.querySelectorAll('.theme-section-label')
      var anchor = null
      for (var i = 0; i < labels.length; i++) {
        if (String(labels[i].textContent || '').trim() === '数据管理') {
          anchor = labels[i]
          break
        }
      }
      if (!anchor || !anchor.parentNode) return

      var wrap = document.createElement('div')
      wrap.id = 'dsh-widget-toggle'
      wrap.style.cssText = 'margin:18px 0 6px;'

      var label = document.createElement('div')
      label.className = 'theme-section-label'
      label.style.cssText = 'margin-bottom:10px;'
      label.textContent = '悬浮窗'

      var card = document.createElement('div')
      card.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:16px;'
        + 'background:var(--bg-card,#fff);border:1px solid var(--border-light,#EAECEF);'

      var text = document.createElement('div')
      text.style.cssText = 'flex:1 1 auto;min-width:0;'

      var line1 = document.createElement('div')
      line1.textContent = '定时任务悬浮窗'
      line1.style.cssText = 'font-weight:600;font-size:.9rem;color:var(--text-primary,#2D3036);'

      var line2 = document.createElement('div')
      line2.textContent = '在 Harness 页面常驻显示未完成任务数与到点提醒，可拖动、可缩放。'
      line2.style.cssText = 'margin-top:3px;font-size:.75rem;line-height:1.5;color:var(--text-secondary,#8A8F99);'

      text.appendChild(line1)
      text.appendChild(line2)

      var sw = document.createElement('button')
      sw.type = 'button'
      sw.setAttribute('role', 'switch')
      sw.style.cssText = 'position:relative;flex:0 0 auto;width:46px;height:26px;border-radius:999px;border:0;'
        + 'padding:0;cursor:pointer;transition:background .18s ease;'

      var knob = document.createElement('span')
      knob.style.cssText = 'position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;'
        + 'background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s ease;'
      sw.appendChild(knob)

      var paint = function (hidden) {
        sw.setAttribute('aria-checked', hidden ? 'false' : 'true')
        sw.style.background = hidden ? '#D6DAE1' : '#2D3036'
        knob.style.transform = hidden ? 'translateX(0)' : 'translateX(20px)'
      }
      paint(readWidgetHidden())

      sw.addEventListener('click', function () {
        var currentlyVisible = sw.getAttribute('aria-checked') === 'true'
        var nextHidden = currentlyVisible
        paint(nextHidden)
        writeWidgetHidden(nextHidden)
        try {
          report('widget:toggle', { hidden: nextHidden })
        } catch (err) {
          /* ignore */
        }
      })

      card.appendChild(text)
      card.appendChild(sw)
      wrap.appendChild(label)
      wrap.appendChild(card)
      anchor.parentNode.insertBefore(wrap, anchor)
      report('widget:toggle-injected', null)
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * 摘掉 AI 面板里不需要的页签。
   *
   *   · 设置：原本是「模型供应商 / 选择模型 / API Key / 保存设置」，
   *     现在 AI 一律走 DeepSeek Harness，没有任何 provider 或密钥需要配置。
   *   · 工作流：功能已废弃，直接去掉整页。
   */
  var HIDDEN_TABS = ['设置', '工作流']

  /**
   * 修掉两处「AI AI」重复文案。
   *
   * 1) 头部：图标是 "AI"，标题又叫 "AI 助手" → 隐藏图标。
   * 2) 处理流程：`连接 ${providerLabel} AI...`，当 provider 取不到名字时
   *    providerLabel 会回退成 "AI"，拼成「连接 AI AI…」→ 归一成「连接 DeepSeek…」。
   */
  function polishAiLabels() {
    try {
      var icons = document.querySelectorAll('.side-panel .panel-icon')
      for (var i = 0; i < icons.length; i++) icons[i].style.display = 'none'

      var steps = document.querySelectorAll('.process-step')
      for (var j = 0; j < steps.length; j++) {
        var el = steps[j]
        for (var k = 0; k < el.childNodes.length; k++) {
          var node = el.childNodes[k]
          if (node.nodeType === 3 && typeof node.nodeValue === 'string' && /AI\s*AI/.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(/AI\s*AI/g, 'DeepSeek')
          }
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  function hideUnwantedTabs() {
    try {
      var tabs = document.querySelectorAll('.panel-tab')
      for (var i = 0; i < tabs.length; i++) {
        var label = String(tabs[i].textContent || '').trim()
        if (HIDDEN_TABS.indexOf(label) >= 0) {
          tabs[i].style.display = 'none'
          // 一旦它正处于激活态，顺手把同级其它按钮点一下，避免停在被隐藏的页上
          if (tabs[i].getAttribute('data-dsh-tab-moved') !== '1' &&
              /active|is-active/.test(tabs[i].className || '')) {
            for (var j = 0; j < tabs.length; j++) {
              if (j === i) continue
              if (HIDDEN_TABS.indexOf(String(tabs[j].textContent || '').trim()) >= 0) continue
              tabs[i].setAttribute('data-dsh-tab-moved', '1')
              try { tabs[j].click() } catch (err) { /* ignore */ }
              break
            }
          }
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * 工作流页签的「清除显示」按钮。
   *
   * 原来的实现是「删掉 localStorage.ai_wf_messages + location.reload()」：
   *   · 删的是**数据**（对话记录），不是用户想要的；
   *   · reload 整个 iframe，面板会因此整个失效 ——「所有聊天都用不了」就是这么来的。
   *
   * 现在只清「页面」：给当前屏幕上的每条气泡行打一个标记，用一条 !important 的
   * CSS 把打过标记的行藏起来。React 的 state、localStorage、后端数据一律不动，
   * 也不重载页面。属性 React 不认领，重渲染时不会被抹掉；新来的消息没有标记，
   * 照常显示。再点一次可以恢复显示。
   */
  var VIEW_CLEARED_ATTR = 'data-dsh-view-cleared'
  var VIEW_CLEAR_STYLE_ID = 'dsh-clear-view-style'

  function ensureClearViewStyle() {
    try {
      if (document.getElementById(VIEW_CLEAR_STYLE_ID)) return
      var style = document.createElement('style')
      style.id = VIEW_CLEAR_STYLE_ID
      // !important 才能压过 React 写在行上的内联 display:flex
      style.textContent = '[' + VIEW_CLEARED_ATTR + '="1"]{display:none !important}'
      ;(document.head || document.documentElement).appendChild(style)
    } catch (err) {
      /* ignore */
    }
  }

  /** 把工作流面板里当前可见的气泡行打上/摘掉「已清屏」标记。 */
  function markViewCleared(pane, cleared) {
    if (!pane) return
    var bubbles = pane.querySelectorAll('.chat-bubble')
    for (var i = 0; i < bubbles.length; i++) {
      var line = bubbles[i].parentElement || bubbles[i]
      if (cleared) line.setAttribute(VIEW_CLEARED_ATTR, '1')
      else line.removeAttribute(VIEW_CLEARED_ATTR)
    }
  }

  function countViewCleared(pane) {
    if (!pane) return 0
    return pane.querySelectorAll('[' + VIEW_CLEARED_ATTR + '="1"]').length
  }

  /**
   * 改造工作流页签顶部那一行。
   *
   * 原来的内容是 <div><label>模型：</label><select …/></div>：
   *   · 模型选择器去掉（AI 固定走 DSH 的 DeepSeek）
   *   · 同一行腾给「清除显示」按钮
   */
  function tuneWorkflowRow() {
    try {
      var labels = document.querySelectorAll('.side-panel label')
      for (var i = 0; i < labels.length; i++) {
        var text = String(labels[i].textContent || '').replace(/\s/g, '')
        if (text !== '模型：' && text !== '模型:') continue
        var label = labels[i]
        var row = label.parentElement
        if (!row) return
        var select = row.querySelector('select')
        // 模型选择器藏起来，位置让给清屏按钮
        label.style.display = 'none'
        if (select) select.style.display = 'none'
        if (row.querySelector('[data-dsh-clear-wf]')) return

        var btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute('data-dsh-clear-wf', '1')
        // 用应用自己的次级按钮样式，和面板里其它按钮（发送 / 保存到当天日志等）同一套
        btn.className = 'btn btn-secondary btn-sm'
        btn.style.cssText = 'white-space:nowrap;'

        /** 按钮文案跟着「当前有没有被藏起来的行」走。 */
        var syncLabel = function () {
          var hidden = countViewCleared(row.parentElement)
          btn.textContent = hidden > 0 ? '恢复显示' : '清除显示'
          btn.title = hidden > 0
            ? '把刚才隐藏的对话显示回来（记录与数据一直没被改动）'
            : '只清空工作流页签上的对话显示，不删除任何记录'
        }

        // 单击即生效，不做二次确认（Electron 也会拦截原生 confirm）
        btn.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          var pane = row.parentElement
          var alreadyCleared = countViewCleared(pane) > 0
          ensureClearViewStyle()
          markViewCleared(pane, !alreadyCleared)
          syncLabel()
          report('workflow-view-' + (alreadyCleared ? 'restored' : 'cleared'), {
            at: new Date().toISOString(),
            hidden: countViewCleared(pane),
          })
        })

        row.appendChild(btn)
        syncLabel()
        report('workflow-clear-button-added', null)
        return
      }
    } catch (err) {
      /* ignore */
    }
  }

  /** 当前 AI 路由（provider/model），从宿主 /status 取一次并缓存。 */
  var aiRouteCache = null
  function getAiRoute() {
    if (aiRouteCache) return Promise.resolve(aiRouteCache)
    return fetch(ROUTE_ROOT + '/status', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (data && data.ai) aiRouteCache = { provider: data.ai.provider, model: data.ai.model }
        return aiRouteCache
      })
      .catch(function () { return null })
  }

  function formatNumber(value) {
    try {
      return Number(value || 0).toLocaleString()
    } catch (err) {
      return String(value || 0)
    }
  }

  // ---- 用量账本（跨重启持久化，存在同源 localStorage 里）-------------------
  // host 侧的内存计费每次重启都会清零，所以账本放在浏览器这一侧：
  // 日历页和 DSH 面板同源（dsh-app://app），两边读同一个 key。
  var USAGE_KEY = 'dsh_ai_calendar_usage_v1'

  function localDateKey() {
    var d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  function loadUsageBook() {
    try {
      var raw = localStorage.getItem(USAGE_KEY)
      if (raw) {
        var parsed = JSON.parse(raw)
        if (parsed && parsed.totals && parsed.days) return parsed
      }
    } catch (err) {
      /* ignore */
    }
    return {
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, costRmb: 0 },
      days: {},
      last: null,
    }
  }

  /** 记一次 AI 调用：总计 + 当日分桶。 */
  function recordUsage(cost) {
    if (!cost) return
    try {
      var book = loadUsageBook()
      var day = localDateKey()
      var bucket = book.days[day] || { calls: 0, inputTokens: 0, outputTokens: 0, costRmb: 0 }
      var input = Number(cost.inputTokens || 0)
      var output = Number(cost.outputTokens || 0)
      var rmb = Number(cost.rmb || 0)

      bucket.calls += 1
      bucket.inputTokens += input
      bucket.outputTokens += output
      bucket.costRmb = Number((bucket.costRmb + rmb).toFixed(6))
      book.days[day] = bucket

      book.totals.calls += 1
      book.totals.inputTokens += input
      book.totals.outputTokens += output
      book.totals.costRmb = Number((book.totals.costRmb + rmb).toFixed(6))
      book.last = { at: new Date().toISOString(), inputTokens: input, outputTokens: output, costRmb: rmb }

      // 只留最近 30 天
      var keys = Object.keys(book.days).sort()
      while (keys.length > 30) delete book.days[keys.shift()]

      localStorage.setItem(USAGE_KEY, JSON.stringify(book))
    } catch (err) {
      /* 隐私模式下写不了就算了，不影响对话 */
    }
  }

  /**
   * AI 直接写后端数据库，应用的 React 状态并不知道 → 日历格子还是旧的。
   *
   * 这个应用的 useLogs 里 fetchLogs 依赖 [year, month]，所以「切到下一月再切回来」
   * 会触发两次重新拉取，最终停回原来的月份、数据却是新的。
   * 比 reload iframe 温和：不清对话历史，也不关面板。
   */
  function refreshCalendarViewIfWrote(data) {
    try {
      var executed = data && data.executed
      if (!Array.isArray(executed)) return
      var wrote = false
      for (var i = 0; i < executed.length; i++) {
        if (executed[i] && executed[i].ok) {
          wrote = true
          break
        }
      }
      if (!wrote) return

      var next = document.querySelector('button.nav-btn[aria-label="下个月"]')
      var prev = document.querySelector('button.nav-btn[aria-label="上个月"]')
      if (!next || !prev) {
        report('refresh:no-month-nav', null)
        return
      }
      report('refresh:month-bounce', null)
      next.click()
      setTimeout(function () {
        try {
          prev.click()
        } catch (err) {
          /* ignore */
        }
      }, 600)
    } catch (err) {
      report('refresh:failed', String((err && err.message) || err))
    }
  }

  /**
   * 在最新一条助手气泡下方追加一行常驻标注：
   *   模型 <provider>/<model> · 入 N / 出 M tokens · ¥0.0039
   * 气泡由 React 渲染，所以用轮询等它出现；已标注过的不再重复。
   */
  function annotateLastReply(data) {
    // 只有真正的对话/总结响应才标注；config、providers、history 这类也会命中 /api/ai/*
    if (!data || (!data.reply && !data.summary && !data.cost)) return
    var attempts = 0
    report('annotate-start', {
      hasCost: Boolean(data && data.cost),
      model: (data && data.model) || '',
      keys: data ? Object.keys(data) : [],
    })
    var timer = setInterval(function () {
      attempts += 1
      try {
        var bubbles = document.querySelectorAll('.chat-bubble.assistant')
        var target = bubbles[bubbles.length - 1]
        var ready = target && String(target.textContent || '').trim().length > 1
        if (ready && target.querySelector('[data-dsh-cost]')) {
          // 这条已经标注过了，别空转
          clearInterval(timer)
          return
        }
        if (ready && !target.querySelector('[data-dsh-cost]')) {
          clearInterval(timer)
          var cost = data && data.cost
          var provider = (data && data.provider) || ''
          var model = (data && data.model) || ''
          var finish = function (route) {
            try {
              if (route) {
                provider = provider || route.provider || ''
                model = model || route.model || ''
              }
              var parts = []
              if (model) parts.push('模型 ' + (provider ? provider + '/' : '') + model)
              if (cost) {
                parts.push('入 ' + formatNumber(cost.inputTokens) + ' / 出 ' + formatNumber(cost.outputTokens) + ' tokens')
                parts.push('¥' + Number(cost.rmb || 0).toFixed(4))
              }
              if (parts.length === 0) return
              var note = document.createElement('div')
              note.setAttribute('data-dsh-cost', '1')
              note.style.cssText = 'margin-top:7px;font:400 11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;'
                + 'color:#8b9099;letter-spacing:.01em;'
              note.textContent = parts.join(' · ')
              target.appendChild(note)
              report('annotate-done', note.textContent)
            } catch (err) {
              report('annotate-append-failed', String((err && err.message) || err))
            }
          }
          if (!model) {
            getAiRoute().then(function (route) { finish(route) })
          } else {
            finish(null)
          }
          return
        }
        if (attempts > 40) {
          clearInterval(timer)
          report('annotate-no-bubble', { attempts, found: bubbles.length })
        }
      } catch (err) {
        clearInterval(timer)
      }
    }, 150)
  }

  // 用 MutationObserver 兜住 React 重渲染后重新出现的入口
  function keepAiHidden() {
    installAiHider()
    hideUnwantedTabs()
    polishAiLabels()
    injectWidgetToggle()
    var observer = new MutationObserver(function () {
      if (!document.getElementById('dsh-ai-calendar-hide-ai')) installAiHider()
      hideUnwantedTabs()
      polishAiLabels()
      injectWidgetToggle()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', keepAiHidden, { once: true })
    installAiHider()
    hideUnwantedTabs()
    polishAiLabels()
    injectWidgetToggle()
  } else {
    keepAiHidden()
  }

  // 预热 AI 路由缓存（provider/model），供气泡标注与对话注入使用
  getAiRoute().catch(function () {})

  window.__dshCalendarBridge = {
    apiBase: ROUTE_ROOT + '/api',
    aiRoute: function () {
      return aiRouteCache
    },
  }
})()
