/**
 * dsh-conversation-flow — client half.
 *
 * Adds ↶ / ⟳ / ✕ buttons to each user message row and hides the transcript
 * spans shadowed by an applied rewind record. DSH 0.2.x exposes no event seq to
 * client plugins, so the Host maps rendered `data-chat-turn` values back to log
 * seqs (`/api/dsh-conversation-flow/status`) and performs the action
 * (`/api/dsh-conversation-flow/execute`).
 *
 * Plain DOM on purpose: no React/JSX build step, no dependency on the removed
 * conversation snapshot hooks — only `data-chat-*` row attributes and the
 * session list snapshot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-flow',
  factory: require => {
    const STATUS_PATH = '/api/dsh-conversation-flow/status'
    const EXECUTE_PATH = '/api/dsh-conversation-flow/execute'
    const PANEL_ATTR = 'data-conversation-flow-panel'
    const USER_ROW_SELECTOR = '[data-chat-flow-kind="user"][data-chat-turn]'
    const TURN_ROW_SELECTOR = '[data-chat-turn]'
    const REFRESH_MS = 2000

    const MODES = [
      { mode: 'both', glyph: '↶', title: '倒带到这里：对话回退并恢复文件' },
      { mode: 'regen', glyph: '⟳', title: '重新生成这一轮：旧结果留在日志里' },
      { mode: 'chat', glyph: '✕', title: '只删除这一轮对话，文件不动' },
    ]

    function currentSessionIdOf(list) {
      if (list === null || typeof list !== 'object') return undefined
      if (typeof list.current === 'string' && list.current !== '') return list.current
      const byId = list.byId
      if (byId === null || typeof byId !== 'object') return undefined
      for (const key of Object.keys(byId)) {
        const summary = byId[key]
        const retained = summary?.retainedBy?.mainView
        if (typeof retained === 'number' && retained > 0 && typeof summary.id === 'string') return summary.id
      }
      return undefined
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: { code: 'bad-response', message: text || response.statusText } }
      }
    }

    function setHidden(row, hidden) {
      if (hidden) {
        if (row.getAttribute('data-flow-hidden') !== '1') {
          row.setAttribute('data-flow-hidden', '1')
          row.style.display = 'none'
        }
      } else if (row.getAttribute('data-flow-hidden') === '1') {
        row.removeAttribute('data-flow-hidden')
        row.style.display = ''
      }
    }

    function findActionsHost(row) {
      const byClass = row.querySelector('[class*="actions"]')
      if (byClass !== null) return byClass
      const hoverRoot = row.querySelector('[data-time-hover-root="true"]')
      if (hoverRoot !== null) return hoverRoot
      return row
    }

    function panelFor(onPick) {
      const panel = document.createElement('span')
      panel.setAttribute(PANEL_ATTR, '1')
      panel.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:2px',
        'margin-left:6px',
        'vertical-align:middle',
        'opacity:.55',
      ].join(';')
      for (const def of MODES) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = def.glyph
        button.title = def.title
        button.setAttribute('aria-label', def.title)
        button.style.cssText = [
          'border:0',
          'background:transparent',
          'cursor:pointer',
          'font-size:14px',
          'line-height:1',
          'padding:2px',
          'color:inherit',
          'border-radius:4px',
        ].join(';')
        button.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          onPick(def.mode)
        })
        panel.appendChild(button)
      }
      return panel
    }

    function confirmText(mode, turn) {
      if (mode === 'both') return `倒带到第 ${turn} 轮提问之前？\n\n• 这轮及之后的对话将从上下文中移除（日志仍保留）\n• 工作区文件会恢复到这一轮提问时的状态`
      if (mode === 'regen') return `重新生成第 ${turn} 轮？\n\n• 这一轮及之后的对话从上下文移除（日志仍保留）\n• 立即用同样的提问内容重跑一次`
      return `删除第 ${turn} 轮对话？\n\n• 仅从对话上下文中移除这一轮及之后（日志仍保留）\n• 不改动工作区文件`
    }

    function apply(ctx) {
      if (window.__dshConversationFlowClientMounted === true) return () => {}
      window.__dshConversationFlowClientMounted = true
      const sessions = ctx.sessions
      let disposed = false
      let scheduled = false
      let inflightRefresh = false
      let sessionId
      let status
      let observer
      let timer
      /** @type {Map<string, HTMLElement>} */
      const panels = new Map()

      function clearPanels() {
        for (const panel of panels.values()) panel.remove()
        panels.clear()
      }

      function clearHidden() {
        for (const row of document.querySelectorAll(TURN_ROW_SELECTOR)) setHidden(row, false)
      }

      async function run(mode, turn, seq) {
        if (sessionId === undefined) return
        if (!window.confirm(confirmText(mode, turn))) return
        try {
          const result = await postJson(EXECUTE_PATH, { sessionId, targetSeq: seq, mode })
          if (result?.ok !== true) {
            const message = result?.error?.message ?? result?.error?.code ?? '未知错误'
            window.alert(`操作失败：${message}`)
            return
          }
          if (mode === 'both' && result.restore?.error !== undefined) {
            window.alert(`对话已回退，但文件恢复不可用：${result.restore.message ?? result.restore.error}`)
          }
          await sessions?.refresh?.()
          schedule()
        } catch (error) {
          window.alert(`操作失败：${String(error?.message ?? error)}`)
        }
      }

      function render() {
        if (disposed || status?.ok !== true) return
        const shadowed = new Set()
        for (const marker of status.markers ?? []) {
          for (const turn of marker?.shadowedTurns ?? []) {
            if (typeof turn === 'number') shadowed.add(turn)
          }
        }
        for (const row of document.querySelectorAll(TURN_ROW_SELECTOR)) {
          const turn = Number(row.getAttribute('data-chat-turn'))
          if (Number.isFinite(turn)) setHidden(row, shadowed.has(turn))
        }
        const seqByTurn = new Map()
        for (const turn of status.turns ?? []) {
          if (Number.isSafeInteger(turn?.turn) && Number.isSafeInteger(turn?.userSeq)) {
            seqByTurn.set(turn.turn, turn.userSeq)
          }
        }
        const sessionPrefix = `${sessionId}:`
        for (const row of document.querySelectorAll(USER_ROW_SELECTOR)) {
          const turn = Number(row.getAttribute('data-chat-turn'))
          const seq = seqByTurn.get(turn)
          if (seq === undefined || shadowed.has(turn)) continue
          const key = `${sessionPrefix}${turn}`
          const existing = panels.get(key)
          if (existing !== undefined && existing.isConnected) continue
          if (existing !== undefined) panels.delete(key)
          const panel = panelFor(mode => {
            void run(mode, turn, seq)
          })
          findActionsHost(row).appendChild(panel)
          panels.set(key, panel)
        }
        for (const [key, panel] of panels) {
          if (!panel.isConnected || !key.startsWith(sessionPrefix)) {
            panel.remove()
            panels.delete(key)
          }
        }
      }

      async function refresh() {
        if (disposed || inflightRefresh) return
        inflightRefresh = true
        try {
          const list = sessions?.list?.getSnapshot?.()
          const nextSessionId = currentSessionIdOf(list)
          if (nextSessionId === undefined) return
          sessionId = nextSessionId
          const nextStatus = await postJson(STATUS_PATH, { sessionId })
          if (disposed) return
          status = nextStatus
          render()
        } catch {
          // transient fetch failure: the next tick retries
        } finally {
          inflightRefresh = false
        }
      }

      function schedule() {
        if (disposed || scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          void refresh()
        })
      }

      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') schedule()
      }, REFRESH_MS)
      schedule()

      return () => {
        disposed = true
        observer?.disconnect()
        if (timer !== undefined) clearInterval(timer)
        clearPanels()
        clearHidden()
        window.__dshConversationFlowClientMounted = false
      }
    }

    return { inject: ['sessions'], apply }
  },
})
