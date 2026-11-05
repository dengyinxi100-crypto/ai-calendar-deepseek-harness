/* dsh-ai-calendar —— client 半边（带诊断日志版）
 *
 * 设计要点：
 *   1. 全程打点：模块求值、__ModuleLoader__ 注册、boot 图、apply、每个 slot 注册结果，
 *      全部 POST 到 /dsh-calendar/log，由 host 落盘（%TEMP%\dsh-ai-calendar\diag.log）。
 *   2. **激活延后**：apply() 只排一个宏任务就返回，真正的 slot 注册在 boot 结算之后执行。
 *      DSH 的 boot gate 只看 fiber 状态，apply 同步返回即算激活成功，所以注册阶段
 *      再怎么抛异常也不会再把整个 Web 界面拖垮。
 */
;(function () {
  'use strict'

  var LOG_URL = '/dsh-calendar/log'

  function post(payload) {
    try {
      var text = JSON.stringify(payload)
      // 只用 fetch(keepalive)：sendBeacon 会被宿主栅栏静默丢弃且返回 true
      fetch(LOG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
        keepalive: true,
      }).catch(function () {})
      return true
    } catch (err) {
      return false
    }
  }

  function log(event, detail) {
    try {
      console.log('[ai-calendar]', event, detail === undefined ? '' : detail)
    } catch (ignored) { /* ignore */ }
    var body = {
      event: event,
      at: new Date().toISOString(),
      href: (typeof location !== 'undefined' ? location.href : ''),
    }
    if (detail !== undefined) {
      try {
        body.detail = typeof detail === 'string' ? detail : JSON.stringify(detail)
      } catch (err) {
        body.detail = String(detail)
      }
    }
    post(body)
  }

  function describeError(err) {
    if (!err) return String(err)
    return String((err && err.stack) || (err && err.message) || err)
  }

  log('module:eval-start')

  // boot 图：确认本插件是否被 host 写进了 __DSH_BOOT__，以及它的 bundle URL
  try {
    var boot = window.__DSH_BOOT__
    if (boot && boot.entries) {
      var mine = null
      var ids = []
      for (var i = 0; i < boot.entries.length; i++) {
        var entry = boot.entries[i]
        if (!entry) continue
        ids.push(entry.id)
        if (entry.id === 'dsh-ai-calendar') mine = entry
      }
      log('boot:graph', { count: ids.length, hasMine: mine !== null, mine: mine, ids: ids.slice(0, 40) })
    } else {
      log('boot:graph-missing', { hasBoot: !!boot })
    }
  } catch (err) {
    log('boot:graph-error', describeError(err))
  }

  try {
    window.__ModuleLoader__.load({
      id: 'dsh-ai-calendar',
      factory: function (require) {
        log('factory:enter')

        var module = { exports: {} }
        var exports = module.exports

        var React = null
        try {
          React = require('react')
          log('factory:react-ok')
        } catch (err) {
          log('factory:react-failed', describeError(err))
        }

        var PANEL_ID = 'ai-calendar'
        var PANEL_ORDER = 30
        var ROUTE_ROOT = '/dsh-calendar'
        var FALLBACK_URL = '/dsh-calendar/app/'

        /** 本地日期键（YYYY-MM-DD），与 shim 记账用的口径一致。 */
        function localDateKey() {
          var d = new Date()
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        }

        var CSS = [
          '[data-dsh-ai-calendar-view]{box-sizing:border-box;display:flex;flex-direction:column;',
          'width:100%;height:100%;min-width:0;min-height:0;',
          'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
          'font-family:var(--dsw-font-family,inherit)}',
          '.dsh-ac-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:40px;padding:0 14px;',
          'border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;line-height:1;',
          'color:var(--dsw-alias-label-secondary)}',
          '.dsh-ac-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;',
          'background:var(--dsw-alias-state-idle-primary,#8b8f9a);transition:background .16s}',
          '.dsh-ac-dot[data-phase="ready"]{background:var(--dsw-alias-state-success-primary)}',
          '.dsh-ac-dot[data-phase="booting"]{background:var(--dsw-alias-state-warn-primary)}',
          '.dsh-ac-dot[data-phase="error"]{background:var(--dsw-alias-state-error-primary)}',
          '.dsh-ac-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
          '.dsh-ac-status{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;',
          'overflow:hidden;text-overflow:ellipsis;min-width:0}',
          '.dsh-ac-spacer{flex:1 1 auto}',
          '.dsh-ac-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;',
          'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;',
          'padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;',
          'transition:background .16s,border-color .16s,color .16s}',
          '.dsh-ac-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
          '.dsh-ac-btn:active{background:var(--dsw-alias-bg-layer-1)}',
          '.dsh-ac-body{position:relative;flex:1 1 auto;min-height:0;background:var(--dsw-alias-bg-base)}',
          '.dsh-ac-usage{font-size:11px;line-height:1;padding:5px 8px;border-radius:999px;white-space:nowrap;',
          'border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);',
          'background:var(--dsw-alias-bg-layer-2)}',
          '.dsh-ac-usage b{font-weight:600;color:var(--dsw-alias-label-primary)}',
          '.dsh-ac-frame{display:block;width:100%;height:100%;border:0;background:#fff}',
          '.dsh-ac-veil{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
          'justify-content:center;gap:10px;padding:24px;text-align:center;',
          'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);',
          'font-size:13px;line-height:1.6}',
          '.dsh-ac-spin{width:20px;height:20px;border-radius:50%;',
          'border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);',
          'animation:dsh-ac-spin .8s linear infinite}',
          '@keyframes dsh-ac-spin{to{transform:rotate(360deg)}}',
          '.dsh-ac-hint{max-width:520px;opacity:.8}',
          '.dsh-ac-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;',
          'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
          'border-radius:6px;padding:2px 6px}',
        ].join('')

        function ensureStyle() {
          if (typeof document === 'undefined') return 'no-document'
          var selector = 'style[data-plugin-css="dsh-ai-calendar/ui.css"]'
          if (document.querySelector(selector) !== null) return 'already'
          var tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-ai-calendar'
          tag.dataset.pluginCss = 'dsh-ai-calendar/ui.css'
          tag.textContent = CSS
          ;(document.head || document.documentElement).appendChild(tag)
          return 'injected'
        }

        function CalendarIcon(props) {
          var size = (props && props.size) || 16
          return React.createElement(
            'svg',
            {
              'data-dsh-panel-entry': PANEL_ID,
              viewBox: '0 0 16 16',
              width: size,
              height: size,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            React.createElement('rect', { key: 'r', x: 2, y: 3, width: 12, height: 11, rx: 1.5 }),
            React.createElement('path', { key: 'h', d: 'M2 6.5h12' }),
            React.createElement('path', { key: 'l', d: 'M5.5 1.7v2.6M10.5 1.7v2.6' }),
          )
        }

        function CalendarPanel() {
          var phaseState = React.useState('idle')
          var phase = phaseState[0]
          var setPhase = phaseState[1]

          var urlState = React.useState('')
          var url = urlState[0]
          var setUrl = urlState[1]

          var errorState = React.useState('')
          var error = errorState[0]
          var setError = errorState[1]

          var nonceState = React.useState(0)
          var nonce = nonceState[0]
          var setNonce = nonceState[1]

          // AI 用量：账本在 localStorage（shim 每次调用后写入），跨重启不丢。
          // host 的 /api/ai/usage 只用来取单价口径与提示文案。
          var usageState = React.useState(null)
          var usage = usageState[0]
          var setUsage = usageState[1]

          React.useEffect(function () {
            var stopped = false
            var patch = function (extra) {
              if (stopped) return
              setUsage(function (prev) {
                return Object.assign({}, prev || {}, extra)
              })
            }
            var readBook = function () {
              try {
                var raw = localStorage.getItem('dsh_ai_calendar_usage_v1')
                var book = raw ? JSON.parse(raw) : null
                var day = localDateKey()
                patch({
                  today: book && book.days ? book.days[day] || null : null,
                  totals: book ? book.totals : null,
                })
              } catch (err) {
                /* ignore */
              }
            }
            var readMeta = function () {
              fetch(ROUTE_ROOT + '/api/ai/usage', { headers: { accept: 'application/json' } })
                .then(function (res) { return res.json() })
                .then(function (data) {
                  if (data) patch({ pricing: data.pricing || null, notice: data.notice || '' })
                })
                .catch(function () {})
            }
            readBook()
            readMeta()
            var bookTimer = setInterval(readBook, 5000)
            var metaTimer = setInterval(readMeta, 60000)
            return function () {
              stopped = true
              clearInterval(bookTimer)
              clearInterval(metaTimer)
            }
          }, [])

          // iframe 与本页同源，可以直接检查里面到底渲染出东西没有
          var blankFixRef = React.useRef(false)

          var onFrameLoad = function (event) {
            var frame = event && event.currentTarget
            setTimeout(function () {
              try {
                var doc = frame && frame.contentDocument
                if (!doc) {
                  log('frame:no-document')
                  return
                }
                var root = doc.getElementById('root')
                var children = root ? root.childElementCount : -1
                var shimLoaded = false
                try {
                  shimLoaded = Boolean(frame.contentWindow && frame.contentWindow.__dshCalendarShim)
                } catch (err) {
                  shimLoaded = false
                }
                log('frame:load', {
                  title: doc.title,
                  url: doc.location && doc.location.href,
                  rootFound: Boolean(root),
                  rootChildren: children,
                  shimLoaded: shimLoaded,
                })
                if (children > 0) {
                  blankFixRef.current = false
                  return
                }
                log('frame:blank')
                if (!blankFixRef.current) {
                  // 第一次空白：多半是资源还没就绪，自动重载一次
                  blankFixRef.current = true
                  setTimeout(function () {
                    setNonce(function (n) { return n + 1 })
                  }, 500)
                  return
                }
                setError('日历页面已加载，但内容是空的（前端资源可能没取到）。')
                setPhase('error')
              } catch (err) {
                log('frame:inspect-failed', describeError(err))
              }
            }, 1200)
          }

          var boot = React.useCallback(function () {
            setPhase('booting')
            setError('')
            log('panel:ensure-request')
            fetch(ROUTE_ROOT + '/ensure', { method: 'POST', headers: { accept: 'application/json' } })
              .then(function (res) { return res.json().catch(function () { return {} }) })
              .then(function (data) {
                if (data && data.running) {
                  log('panel:ensure-ok', data)
                  setUrl(data.url || FALLBACK_URL)
                  setPhase('ready')
                  return
                }
                log('panel:ensure-failed', data)
                setError((data && data.error) || '后端未响应。')
                setPhase('error')
              })
              .catch(function (err) {
                log('panel:ensure-error', describeError(err))
                setError(String((err && err.message) || err))
                setPhase('error')
              })
          }, [])

          React.useEffect(function () { boot() }, [boot])

          var onRefresh = function () {
            if (phase === 'ready') setNonce(function (n) { return n + 1 })
            else boot()
          }

          var statusText = phase === 'ready'
            ? ''
            : phase === 'booting' ? '正在启动服务…'
              : phase === 'error' ? '服务未就绪' : ''

          var today = usage && usage.today
          var totals = usage && usage.totals
          var usageTip = []
          if (totals) {
            usageTip.push('总计 ¥' + Number(totals.costRmb || 0).toFixed(4)
              + ' · ' + Number(totals.calls || 0) + ' 次调用'
              + ' · 输入 ' + Number(totals.inputTokens || 0).toLocaleString()
              + ' / 输出 ' + Number(totals.outputTokens || 0).toLocaleString() + ' tokens')
          }
          if (usage && usage.pricing) {
            usageTip.push('单价（估算）：输入 ¥' + usage.pricing.inputPerMillionRmb
              + ' / 百万 token，输出 ¥' + usage.pricing.outputPerMillionRmb + ' / 百万 token')
          } else {
            usageTip.push('AI 由 DeepSeek Harness 提供，调用的是 DeepSeek API，按 token 计费（需付费）')
          }
          usageTip.push('账本按天累计并存在本地，重启 DSH 不会清零')

          var bar = React.createElement(
            'div',
            { className: 'dsh-ac-bar', key: 'bar' },
            React.createElement('span', { className: 'dsh-ac-dot', 'data-phase': phase, key: 'dot' }),
            React.createElement('span', { className: 'dsh-ac-title', key: 'title' }, '日历'),
            statusText ? React.createElement('span', { className: 'dsh-ac-status', key: 'status' }, statusText) : null,
            React.createElement('span', { className: 'dsh-ac-spacer', key: 'spacer' }),
            React.createElement(
              'span',
              { className: 'dsh-ac-usage', key: 'usage', title: usageTip.join('\n') },
              'DeepSeek API · 付费',
              today
                ? React.createElement('b', null,
                    '  今日 ¥' + Number(today.costRmb || 0).toFixed(4)
                    + ' / ' + Number((today.inputTokens || 0) + (today.outputTokens || 0)).toLocaleString() + ' tok')
                : null,
            ),
            React.createElement('button', { className: 'dsh-ac-btn', type: 'button', onClick: onRefresh, key: 'refresh' }, '刷新'),
          )

          var bodyChildren = []
          if (phase === 'ready') {
            bodyChildren.push(React.createElement('iframe', {
              key: 'frame-' + nonce,
              className: 'dsh-ac-frame',
              src: url,
              title: 'AI 智能日历',
              allow: 'clipboard-read; clipboard-write; fullscreen',
              referrerPolicy: 'no-referrer',
              onLoad: onFrameLoad,
            }))
          } else {
            var veilChildren = []
            if (phase === 'booting' || phase === 'idle') {
              veilChildren.push(React.createElement('div', { className: 'dsh-ac-spin', key: 'spin' }))
              veilChildren.push(React.createElement('div', { key: 'txt' }, '正在启动日历服务…'))
            } else {
              veilChildren.push(React.createElement('div', { key: 'txt' }, '日历服务没能启动'))
              veilChildren.push(React.createElement('div', { className: 'dsh-ac-hint', key: 'err' }, error))
              veilChildren.push(React.createElement(
                'div',
                { className: 'dsh-ac-hint', key: 'hint' },
                '可在项目目录执行 ',
                React.createElement('code', { className: 'dsh-ac-code' }, 'node server/index.cjs'),
                ' 后再点「刷新」。',
              ))
            }
            bodyChildren.push(React.createElement('div', { className: 'dsh-ac-veil', key: 'veil' }, veilChildren))
          }

          return React.createElement(
            'div',
            { 'data-dsh-ai-calendar-view': '', 'data-dsh-plugin': 'ai-calendar' },
            bar,
            React.createElement('div', { className: 'dsh-ac-body', key: 'body' }, bodyChildren),
          )
        }

        var inject = []

        function readSlots(ctx) {
          var candidates = []
          try { if (ctx && typeof ctx.get === 'function') candidates.push(ctx.get('slots')) } catch (err) { /* ignore */ }
          try { candidates.push(ctx && ctx.slots) } catch (err) { /* ignore */ }
          for (var i = 0; i < candidates.length; i++) {
            var slots = candidates[i]
            if (slots && typeof slots.register === 'function' && typeof slots.inject === 'function') return slots
          }
          return null
        }

        function activatePanel(ctx) {
          log('activate:enter', {
            hasCtx: !!ctx,
            hasEffect: !!(ctx && typeof ctx.effect === 'function'),
            hasGet: !!(ctx && typeof ctx.get === 'function'),
            ctxKeys: ctx ? Object.keys(ctx).slice(0, 40) : null,
          })

          try {
            log('style:' + ensureStyle())
          } catch (err) {
            log('style:failed', describeError(err))
          }

          var slots = readSlots(ctx)
          if (!slots) {
            log('activate:no-slots')
            return
          }
          log('activate:slots-ok', { keys: Object.keys(slots).slice(0, 20) })

          var run = function () {
            var disposers = []
            try {
              disposers.push(slots.inject('sidebar.panellist', function () {
                log('seat:sidebar-available')
                return slots.register({
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: PANEL_ORDER,
                  label: function () { return '日历' },
                }, CalendarIcon)
              }))
              log('seat:sidebar-injected')
            } catch (err) {
              log('seat:sidebar-failed', describeError(err))
            }
            try {
              disposers.push(slots.inject('main', function () {
                log('seat:main-available')
                return slots.register({ name: 'main', key: PANEL_ID }, CalendarPanel)
              }))
              log('seat:main-injected')
            } catch (err) {
              log('seat:main-failed', describeError(err))
            }
            return function () {
              for (var i = 0; i < disposers.length; i++) {
                try { disposers[i]() } catch (err) { /* ignore */ }
              }
            }
          }

          try {
            if (typeof ctx.effect === 'function') {
              ctx.effect(run)
              log('activate:effect-registered')
            } else {
              run()
              log('activate:ran-directly')
            }
          } catch (err) {
            log('activate:effect-failed', describeError(err))
            try {
              run()
              log('activate:ran-after-effect-failure')
            } catch (err2) {
              log('activate:direct-failed', describeError(err2))
            }
          }
        }

        // ---- 定时任务浮窗 + 侧栏未完成计数 ------------------------------------
        // 视觉沿用应用自己的任务卡：白底、#2D3036 文字、#EAECEF 描边、16px 圆角、
        // 柔和投影 + 系统字体栈；有到点提醒时左侧出现红色强调条（和「紧急」卡一致）。
        // 不依赖日历 iframe：只要 DSH 开着就每 30 秒刷新一次。

        var REMINDER_KEY = 'reminders_shown' // 与应用共用，避免同一条弹两次
        var WIDGET_STATE_KEY = 'dsh_ai_calendar_widget_v1'
        var WIDGET_ID = 'dsh-ai-calendar-scheduler'
        var WIDGET_VERSION = '5'
        var UNFINISHED_CATEGORIES = ['task', 'chore', 'work']

        var CARD = {
          bg: '#FFFFFF',
          bgSoft: '#FAFBFC',
          text: '#2D3036',
          text2: '#8A8F99',
          text3: '#B0B5BD',
          line: '#EAECEF',
          lineDash: '#E4E1DC',
          accent: '#E8524A',
          dueBg: '#FDECE9',
          font: '-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Helvetica Neue",sans-serif',
          shadow: '0 12px 32px rgba(0,0,0,.07),0 4px 12px rgba(0,0,0,.05),0 1px 4px rgba(0,0,0,.04)',
        }

        function readShown() {
          try {
            var raw = localStorage.getItem(REMINDER_KEY)
            var arr = raw ? JSON.parse(raw) : []
            return Array.isArray(arr) ? arr : []
          } catch (err) {
            return []
          }
        }

        function writeShown(list) {
          try {
            localStorage.setItem(REMINDER_KEY, JSON.stringify(list.slice(-400)))
          } catch (err) {
            /* ignore */
          }
        }

        function readWidgetState() {
          try {
            var raw = localStorage.getItem(WIDGET_STATE_KEY)
            var parsed = raw ? JSON.parse(raw) : null
            if (parsed && typeof parsed === 'object') return parsed
          } catch (err) {
            /* ignore */
          }
          return { open: true, hidden: false, left: 20, top: null, bottom: 20, width: 300, height: 230 }
        }

        function saveWidgetState(state) {
          try {
            localStorage.setItem(WIDGET_STATE_KEY, JSON.stringify(state))
          } catch (err) {
            /* ignore */
          }
        }

        /** 侧栏「日历」行右侧的未完成计数。 */
        function paintSidebarBadge(count) {
          try {
            var entry = document.querySelector('[data-dsh-panel-entry="ai-calendar"]')
            if (!entry) return
            var row = entry.closest('button') || entry.parentElement
            if (!row) return
            var badge = row.querySelector('[data-dsh-ac-badge]')
            if (!count || count <= 0) {
              if (badge) badge.remove()
              return
            }
            if (!badge) {
              badge = document.createElement('span')
              badge.setAttribute('data-dsh-ac-badge', '1')
              badge.style.cssText = 'margin-left:6px;min-width:16px;height:16px;padding:0 5px;border-radius:999px;'
                + 'display:inline-flex;align-items:center;justify-content:center;'
                + 'font:700 10px/16px ' + CARD.font + ';background:#2D3036;color:#fff;'
              row.appendChild(badge)
            }
            badge.textContent = String(count)
            badge.title = count + ' 个未完成任务'
          } catch (err) {
            /* ignore */
          }
        }

        function applyWidgetGeometry(node, state) {
          node.style.left = state.left + 'px'
          if (typeof state.top === 'number') {
            node.style.top = state.top + 'px'
            node.style.bottom = 'auto'
          } else {
            node.style.top = 'auto'
            node.style.bottom = (typeof state.bottom === 'number' ? state.bottom : 20) + 'px'
          }
          node.style.width = (state.width || 300) + 'px'
          node.style.height = state.open ? (state.height || 230) + 'px' : 'auto'
        }

        function buildWidget(ctx) {
          var existing = document.getElementById(WIDGET_ID)
          if (existing) {
            // 插件热重激活时 DOM 会被复用：如果这份浮窗是旧版本代码建的，
            // 里面绑的还是旧事件处理器，必须重建，否则改了也"没生效"。
            if (existing.getAttribute('data-ac-version') === WIDGET_VERSION && existing.__refs) {
              return existing.__refs
            }
            try {
              existing.remove()
            } catch (err) {
              /* ignore */
            }
            log('widget:rebuilt', { reason: 'version-mismatch' })
          }

          var state = readWidgetState()
          var node = document.createElement('div')
          node.id = WIDGET_ID
          node.setAttribute('data-ac-version', WIDGET_VERSION)
          node.style.cssText = [
            'position:fixed;z-index:2147483646;display:flex;flex-direction:column;',
            'border-radius:16px;overflow:hidden;resize:both;',
            'background:' + CARD.bg + ';color:' + CARD.text + ';',
            // Electron 里顶栏是窗口拖拽区；浮窗必须声明 no-drag，
            // 否则拖到顶栏附近会被宿主当成"拖窗口"，浮窗反而不动
            '-webkit-app-region:no-drag;',
            'border:1px solid ' + CARD.line + ';',
            'box-shadow:' + CARD.shadow + ';',
            'font-family:' + CARD.font + ';font-size:12px;line-height:1.6;',
            'min-width:210px;min-height:96px;',
          ].join('')

          var head = document.createElement('div')
          head.setAttribute('data-dsh-ac-head', '1')
          head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;'
            + 'border-bottom:1px solid ' + CARD.line + ';flex:0 0 auto;user-select:none;background:' + CARD.bg + ';-webkit-app-region:no-drag;'

          var grip = document.createElement('span')
          grip.textContent = '⠿'
          grip.title = '按住拖动'
          grip.style.cssText = 'flex:0 0 auto;color:' + CARD.text3 + ';font-size:12px;letter-spacing:-1px;'

          var title = document.createElement('span')
          title.textContent = '定时任务'
          title.style.cssText = 'font-weight:700;font-size:13px;letter-spacing:-.01em;color:' + CARD.text + ';'

          var count = document.createElement('span')
          count.setAttribute('data-dsh-ac-count', '1')
          count.style.cssText = 'font-size:11px;color:' + CARD.text2 + ';'

          var spacer = document.createElement('span')
          spacer.style.cssText = 'flex:1 1 auto;'

          var btnStyle = 'appearance:none;border:0;background:transparent;color:' + CARD.text3 + ';cursor:pointer;'
            + 'font-size:14px;line-height:1;padding:2px 4px;border-radius:6px;transition:color .15s,background .15s;'

          var collapse = document.createElement('button')
          collapse.type = 'button'
          collapse.textContent = '—'
          collapse.title = '收起 / 展开'
          collapse.style.cssText = btnStyle

          var close = document.createElement('button')
          close.type = 'button'
          close.textContent = '×'
          close.title = '隐藏（提醒到点会重新出现）'
          close.style.cssText = btnStyle + 'font-size:16px;'

          head.appendChild(grip)
          head.appendChild(title)
          head.appendChild(count)
          head.appendChild(spacer)
          head.appendChild(collapse)
          head.appendChild(close)

          var body = document.createElement('div')
          body.setAttribute('data-dsh-ac-body', '1')
          body.style.cssText = 'flex:1 1 auto;overflow:auto;padding:10px 12px;background:' + CARD.bg + ';-webkit-app-region:no-drag;'

          node.appendChild(head)
          node.appendChild(body)
          ;(document.body || document.documentElement).appendChild(node)

          var refs = {
            node: node,
            head: head,
            body: body,
            countEl: count,
            collapse: collapse,
            close: close,
            state: state,
            flashTimer: null,
          }

          // —— 拖动 ——
          // 关键：监听挂在 document 上，而不是标题栏本身。
          // 标题栏上监听的话，指针一旦移出标题栏（或 pointer capture 失败）就收不到 move，
          // 表现就是"拖不动"。同时兼容 pointer 与 mouse 两套事件。
          var drag = null
          var moveTo = function (clientX, clientY) {
            var left = Math.max(4, Math.min(window.innerWidth - 80, clientX - drag.dx))
            var top = Math.max(4, Math.min(window.innerHeight - 40, clientY - drag.dy))
            node.style.left = left + 'px'
            node.style.top = top + 'px'
            node.style.bottom = 'auto'
            refs.state.left = left
            refs.state.top = top
          }
          var onMove = function (event) {
            if (!drag) return
            moveTo(event.clientX, event.clientY)
            try {
              event.preventDefault()
            } catch (err) {
              /* ignore */
            }
          }
          var removeDragListeners = function () {
            document.removeEventListener('pointermove', onMove, true)
            document.removeEventListener('mousemove', onMove, true)
            document.removeEventListener('pointerup', endDrag, true)
            document.removeEventListener('mouseup', endDrag, true)
            document.removeEventListener('pointercancel', endDrag, true)
          }
          var endDrag = function () {
            if (!drag) return
            drag = null
            removeDragListeners()
            saveWidgetState(refs.state)
            log('widget:drag-end', { left: refs.state.left, top: refs.state.top })
          }
          var startDrag = function (event) {
            var target = event.target
            if (target && target.closest && target.closest('button')) return
            if (target && target.closest && target.closest('[data-ac-row]')) return
            if (drag) return
            var rect = node.getBoundingClientRect()
            // 右下角是原生 resize 手柄：让浏览器自己处理，否则被 preventDefault 吃掉就缩放不了
            if (event.clientX > rect.right - 20 && event.clientY > rect.bottom - 20) return
            drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
            document.addEventListener('pointermove', onMove, true)
            document.addEventListener('mousemove', onMove, true)
            document.addEventListener('pointerup', endDrag, true)
            document.addEventListener('mouseup', endDrag, true)
            document.addEventListener('pointercancel', endDrag, true)
            log('widget:drag-start', { x: Math.round(event.clientX), y: Math.round(event.clientY) })
            try {
              event.preventDefault()
            } catch (err) {
              /* ignore */
            }
          }
          // 挂在整卡上（不只标题栏）：抓取面积更大，空白处也能拖；按钮和可点击行除外
          node.addEventListener('pointerdown', startDrag)
          node.addEventListener('mousedown', startDrag)
          node.style.touchAction = 'none'

          // 诊断：如果点击落在浮窗范围内却不是浮窗接到，说明被别的透明层挡住了
          try {
            document.addEventListener('pointerdown', function (event) {
              if (event.target && event.target.closest && event.target.closest('#' + WIDGET_ID)) return
              var rect = node.getBoundingClientRect()
              if (rect.width === 0) return
              if (event.clientX < rect.left || event.clientX > rect.right) return
              if (event.clientY < rect.top || event.clientY > rect.bottom) return
              var topEl = document.elementFromPoint(event.clientX, event.clientY)
              log('widget:pointer-blocked', {
                target: topEl ? (topEl.id || topEl.className || topEl.tagName) : 'none',
              })
            }, true)
          } catch (err) {
            /* ignore */
          }

          // —— 记录尺寸变化 ——
          if (typeof ResizeObserver === 'function') {
            try {
              new ResizeObserver(function () {
                if (!refs.state.open) return
                refs.state.width = Math.round(node.offsetWidth)
                refs.state.height = Math.round(node.offsetHeight)
                saveWidgetState(refs.state)
              }).observe(node)
            } catch (err) {
              /* ignore */
            }
          }

          collapse.addEventListener('click', function () {
            refs.state.open = !refs.state.open
            body.style.display = refs.state.open ? '' : 'none'
            refs.collapse.textContent = refs.state.open ? '—' : '+'
            applyWidgetGeometry(node, refs.state)
            saveWidgetState(refs.state)
          })

          close.addEventListener('click', function () {
            node.style.display = 'none'
            refs.state.hidden = true
            saveWidgetState(refs.state)
          })

          if (!state.open) {
            body.style.display = 'none'
            collapse.textContent = '+'
          }
          applyWidgetGeometry(node, state)
          if (state.hidden) node.style.display = 'none'
          node.__refs = refs

          // 量到 0 尺寸说明挂错了父节点，改挂 documentElement 再试一次
          try {
            var rect = node.getBoundingClientRect()
            if (rect.width < 10 || rect.height < 10) {
              log('widget:zero-rect', { width: rect.width, height: rect.height, parent: node.parentElement ? node.parentElement.tagName : 'none' })
              document.documentElement.appendChild(node)
              applyWidgetGeometry(node, state)
              rect = node.getBoundingClientRect()
            }
            log('widget:created', {
              rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
              display: window.getComputedStyle(node).display,
              viewport: { w: window.innerWidth, h: window.innerHeight },
              parent: node.parentElement ? node.parentElement.tagName : 'none',
            })
          } catch (err) {
            /* ignore */
          }
          return refs
        }

        function clearNode(node) {
          while (node.firstChild) node.removeChild(node.firstChild)
        }

        /** 一行：时间 + 标题（可选淡色 / 到点标签 / 点击跳转）。 */
        function addRow(body, opts) {
          var row = document.createElement('div')
          row.style.cssText = 'display:flex;align-items:baseline;gap:6px;padding:5px 0;'
            + (opts.due ? 'font-weight:600;color:' + CARD.text + ';' : 'color:' + CARD.text2 + ';')

          var dot = document.createElement('span')
          dot.textContent = opts.due ? '⏰' : '·'
          dot.style.cssText = 'flex:0 0 auto;font-size:' + (opts.due ? '12px' : '13px') + ';opacity:' + (opts.due ? '1' : '.6') + ';'
          row.appendChild(dot)

          var when = document.createElement('span')
          when.textContent = opts.time
          when.style.cssText = 'flex:0 0 auto;font-variant-numeric:tabular-nums;'
            + (opts.due ? 'color:' + CARD.accent + ';' : '')
          row.appendChild(when)

          var label = document.createElement('span')
          label.textContent = opts.title
          label.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
          row.appendChild(label)

          if (opts.due) {
            var tag = document.createElement('span')
            tag.textContent = '到点'
            tag.style.cssText = 'flex:0 0 auto;padding:0 6px;border-radius:999px;background:' + CARD.dueBg + ';'
              + 'color:' + CARD.accent + ';font-size:10px;font-weight:600;line-height:16px;'
            row.appendChild(tag)
          }

          if (opts.onClick) {
            row.style.cursor = 'pointer'
            row.setAttribute('data-ac-row', '1')
            row.addEventListener('click', opts.onClick)
          }
          body.appendChild(row)
          return row
        }

        function addDivider(body) {
          var line = document.createElement('div')
          line.style.cssText = 'border-top:1px dashed ' + CARD.lineDash + ';margin:6px 0 4px;'
          body.appendChild(line)
        }

        function openCalendarPanel(ctx) {
          try {
            var layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('ai-calendar')
          } catch (err) {
            /* ignore */
          }
        }

        function renderWidget(refs, data, ctx) {
          if (!refs) return
          refs.countEl.textContent = data.unfinished > 0 ? data.unfinished + ' 未完成' : ''
          clearNode(refs.body)

          // 有到点提醒 → 左侧红色强调条（和任务卡的「紧急」一致）
          refs.node.style.borderLeft = data.due.length > 0
            ? '3px solid ' + CARD.accent
            : '1px solid ' + CARD.line

          var open = function () { openCalendarPanel(ctx) }

          if (data.due.length > 0) {
            for (var i = 0; i < data.due.length; i++) {
              addRow(refs.body, {
                due: true,
                time: data.due[i].reminder_time || '',
                title: data.due[i].title || '',
                onClick: open,
              })
            }
            if (data.upcoming.length > 0) addDivider(refs.body)
          }

          for (var j = 0; j < data.upcoming.length; j++) {
            addRow(refs.body, {
              time: (data.upcoming[j].date || '').slice(5) + ' ' + (data.upcoming[j].reminder_time || ''),
              title: data.upcoming[j].title || '',
              onClick: open,
            })
          }

          if (data.due.length === 0 && data.upcoming.length === 0) {
            addRow(refs.body, { time: '', title: '暂无提醒', onClick: open })
          }

          if (data.unfinished > 0) {
            addDivider(refs.body)
            addRow(refs.body, {
              time: '',
              title: '未完成任务 ' + data.unfinished + ' 个',
              onClick: open,
            })
          }
        }

        function flashWidget(refs) {
          if (!refs) return
          try {
            refs.node.style.display = ''
            refs.state.hidden = false
            saveWidgetState(refs.state)
            if (!refs.state.open) {
              refs.state.open = true
              refs.body.style.display = ''
              refs.collapse.textContent = '—'
              applyWidgetGeometry(refs.node, refs.state)
            }
            if (refs.flashTimer) clearTimeout(refs.flashTimer)
            refs.node.style.boxShadow = '0 0 0 2px ' + CARD.accent + ',' + CARD.shadow
            refs.flashTimer = setTimeout(function () {
              refs.node.style.boxShadow = CARD.shadow
            }, 2600)
            var rect = refs.node.getBoundingClientRect()
            log('widget:flash', {
              rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
              display: window.getComputedStyle(refs.node).display,
            })
          } catch (err) {
            /* ignore */
          }
        }

        function startScheduledWatcher(ctx) {
          var refs = buildWidget(ctx)

          // 对外暴露显隐接口：日历 iframe 里的「主题设置 → 悬浮窗」开关通过 window.parent 调它
          try {
            window.__dshCalendarWidget = {
              setHidden: function (hidden) {
                try {
                  refs.state.hidden = Boolean(hidden)
                  refs.node.style.display = hidden ? 'none' : ''
                  saveWidgetState(refs.state)
                  log('widget:set-hidden', { hidden: Boolean(hidden) })
                } catch (err) {
                  /* ignore */
                }
              },
              isHidden: function () {
                return Boolean(refs.state && refs.state.hidden)
              },
              show: function () {
                this.setHidden(false)
              },
              hide: function () {
                this.setHidden(true)
              },
            }
          } catch (err) {
            /* ignore */
          }

          var shown = readShown()
          var lastSignature = ''
          var lastHeartbeat = 0
          var ticks = 0

          var signatureOf = function (list) {
            return list.map(function (item) {
              return (item.date || '') + '|' + (item.reminder_time || '') + '|' + (item.title || '') + '|' + (item.completed || 0)
            }).join(',')
          }

          var tick = function () {
            Promise.all([
              fetch(ROUTE_ROOT + '/api/logs', { headers: { accept: 'application/json' } })
                .then(function (res) { return res.json() }).catch(function () { return [] }),
              fetch(ROUTE_ROOT + '/api/reminders/check', { headers: { accept: 'application/json' } })
                .then(function (res) { return res.json() }).catch(function () { return [] }),
            ]).then(function (results) {
              var all = Array.isArray(results[0]) ? results[0] : []
              var dueList = Array.isArray(results[1]) ? results[1] : []
              var day = localDateKey()

              var undone = all.filter(function (logItem) {
                if (logItem.completed === 1 || logItem.status === 'completed') return false
                if (logItem.is_periodic === 1) return false
                if (logItem.is_task === 1) return true
                return UNFINISHED_CATEGORIES.indexOf(String(logItem.category || '')) >= 0
              })
              paintSidebarBadge(undone.length)

              var upcoming = all
                .filter(function (logItem) {
                  return logItem.reminder_enabled && logItem.reminder_time && logItem.date &&
                    logItem.date >= day && logItem.completed !== 1 && logItem.status !== 'completed'
                })
                .sort(function (a, b) {
                  return (a.date + ' ' + a.reminder_time).localeCompare(b.date + ' ' + b.reminder_time)
                })
                .slice(0, 4)

              var freshDue = []
              for (var i = 0; i < dueList.length; i++) {
                var item = dueList[i]
                if (!item || !item.id) continue
                var key = item.id + '-' + day
                if (shown.indexOf(key) >= 0) continue
                shown.push(key)
                freshDue.push(item)
              }
              if (freshDue.length > 0) {
                writeShown(shown)
                flashWidget(refs)
                log('reminder:due', { count: freshDue.length, first: freshDue[0].title || '' })
              }

              // 状态变化才打点：能区分「数据没变」和「变了但界面没刷新」
              var signature = undone.length + '/' + signatureOf(upcoming)
              if (signature !== lastSignature) {
                lastSignature = signature
                log('scheduler:state', {
                  unfinished: undone.length,
                  upcoming: upcoming.length,
                  titles: upcoming.map(function (item) { return item.title }).slice(0, 4),
                })
              }

              // 心跳：每分钟记一次，用来确认轮询本身还活着
              ticks += 1
              var nowMs = Date.now()
              if (nowMs - lastHeartbeat > 60000) {
                lastHeartbeat = nowMs
                var rect = refs.node.getBoundingClientRect()
                log('scheduler:heartbeat', {
                  ticks: ticks,
                  unfinished: undone.length,
                  upcoming: upcoming.length,
                  nodeInDom: document.body ? document.body.contains(refs.node) || document.documentElement.contains(refs.node) : false,
                  nodeRect: { w: Math.round(rect.width), h: Math.round(rect.height) },
                  chipText: refs.countEl ? refs.countEl.textContent : '',
                })
              }

              renderWidget(refs, { unfinished: undone.length, due: freshDue, upcoming: upcoming }, ctx)
            }).catch(function (err) {
              log('scheduler:tick-failed', String((err && err.message) || err))
            })
          }

          try {
            tick()
          } catch (err) {
            /* ignore */
          }
          var timer = setInterval(tick, 15000)
          // 切回窗口时立刻刷新一次，不必等下一个 15 秒
          var onFocus = function () {
            try {
              tick()
            } catch (err) {
              /* ignore */
            }
          }
          try {
            window.addEventListener('focus', onFocus)
            document.addEventListener('visibilitychange', function () {
              if (document.visibilityState === 'visible') onFocus()
            })
          } catch (err) {
            /* ignore */
          }
          log('scheduler:watcher-started')
          return function () {
            clearInterval(timer)
            try {
              window.removeEventListener('focus', onFocus)
            } catch (err) {
              /* ignore */
            }
          }
        }

        function apply(ctx) {
          log('apply:enter')
          var run = function () {
            try {
              if (!React) {
                log('apply:no-react')
              } else {
                activatePanel(ctx)
              }
            } catch (err) {
              log('apply:deferred-failed', describeError(err))
            }
            // 提醒轮询不依赖 React，放在安全分支之外单独起
            try {
              startScheduledWatcher(ctx)
            } catch (err) {
              log('reminder:start-failed', describeError(err))
            }
          }
          try {
            // 延后到 boot 结算之后：apply 同步返回 → fiber ACTIVE → boot 必然通过
            setTimeout(run, 0)
            log('apply:scheduled')
          } catch (err) {
            log('apply:schedule-failed', describeError(err))
            run()
          }
        }

        exports.apply = apply
        exports.inject = inject
        log('factory:done')
        return module.exports
      },
    })
    log('module:registered')
  } catch (err) {
    log('module:register-failed', describeError(err))
  }
})()
