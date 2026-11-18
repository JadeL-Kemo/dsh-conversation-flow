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
    const DELETE_PATH = '/api/dsh-conversation-flow/delete-session'
    const VERSIONS_PATH = '/api/dsh-conversation-flow/versions'
    const PANEL_ATTR = 'data-conversation-flow-panel'
    const USER_ROW_SELECTOR = '[data-chat-flow-kind="user"][data-chat-turn]'
    const TURN_ROW_SELECTOR = '[data-chat-turn]'
    const REFRESH_MS = 2000

    const MODES = [
      { mode: 'both', glyph: '↶', title: '倒带到这里：对话回退并恢复文件' },
      { mode: 'regen', glyph: '⟳', title: '重新生成这一轮：旧结果留在日志里' },
      { mode: 'chat', glyph: '✕', title: '只删除这一轮对话，文件不动' },
      { mode: 'edit', glyph: '✎', title: '编辑并重新发送：修改这条提问后重跑' },
    ]

    const EDIT_CHOICES = [
      { value: 'delete', label: '删除后续并重发', hint: '对话回退到这条提问之前，并恢复工作区文件（之后的修改丢弃）' },
      { value: 'archive', label: '归档为分支后重发', hint: '先把当前会话复制成一个独立分支（保留后续对话），主线再回退并恢复文件' },
      { value: 'keep', label: '保留文件改动后重发', hint: '只回退对话上下文，工作区文件保持现状' },
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

    function panelFor(onPick, versionsCount = 0, onVersions) {
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
      if (versionsCount > 0 && typeof onVersions === 'function') {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = `◷${versionsCount}`
        button.title = `查看这一问的 ${versionsCount} 个历史回答（重新生成旧版本）`
        button.setAttribute('aria-label', button.title)
        button.style.cssText = [
          'border:0',
          'background:transparent',
          'cursor:pointer',
          'font-size:12px',
          'line-height:1',
          'padding:2px',
          'color:inherit',
          'border-radius:4px',
        ].join(';')
        button.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          onVersions()
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

    const DELETE_ERRORS = {
      'session-not-found': '会话不存在（可能已被删除）',
      'session-busy': '会话还在运行：先停止这一轮再试',
      'persistence-unavailable': '宿主没有会话存储服务，无法删除',
      'delete-lookup-failed': '读取会话列表失败',
      'delete-failed': '删除失败，日志目录可能只移动了一部分，请查看日志后重试或手动清理',
      'cleanup-failed': '会话已停止，但日志目录只移动了一部分，请查看日志后重试或手动清理',
    }

    /** Delete one session from the context menu (soft delete, 24h recovery). */
    async function deleteSessionFromMenu(sessions, sessionId, displayTitle) {
      const title = typeof displayTitle === 'string' && displayTitle !== '' ? `「${displayTitle}」` : '这个会话'
      const list = sessions?.list?.getSnapshot?.()
      const current = currentSessionIdOf(list)
      const currentNote = current === sessionId ? '\n• 这是当前打开的会话，删除后界面会回到新会话' : ''
      const ok = window.confirm(
        `删除会话${title}？\n\n• 会话目录移入回收站（.sessions-trash），24 小时内可恢复\n• 列表里立即消失${currentNote}`,
      )
      if (!ok) return
      try {
        const result = await postJson(DELETE_PATH, { sessionId })
        if (result?.ok !== true) {
          const code = result?.error?.code
          window.alert(`删除失败：${DELETE_ERRORS[code] ?? result?.error?.message ?? code ?? '未知错误'}`)
          return
        }
        await sessions?.refresh?.()
      } catch (error) {
        window.alert(`删除失败：${String(error?.message ?? error)}`)
      }
    }

    function apply(ctx) {
      if (window.__dshConversationFlowClientMounted === true) return () => {}
      window.__dshConversationFlowClientMounted = true
      const sessions = ctx.sessions

      // Manual session deletion: the host row menu only knows rename / fork /
      // archive, so contribute the missing action through the official
      // context-menu registry (works for archived rows too).
      try {
        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'plugin.sessionDelete',
              target: 'session',
              order: 700,
              resolve: value => {
                const sessionId = value?.sessionId
                if (typeof sessionId !== 'string' || sessionId === '') return []
                return [
                  {
                    id: 'plugin.sessionDelete.run',
                    label: '删除会话',
                    danger: true,
                    separatorBefore: true,
                    run: () => {
                      void deleteSessionFromMenu(sessions, sessionId, value?.displayTitle)
                    },
                  },
                ]
              },
            }),
          'dsh-conversation-flow: session delete menu',
        )
      } catch (error) {
        console.warn(`[conversation-flow] session delete menu unavailable: ${String(error?.message ?? error)}`)
      }

      let disposed = false
      let scheduled = false
      let inflightRefresh = false
      let sessionId
      let status
      let observer
      let timer
      /** @type {Map<string, HTMLElement>} */
      const panels = new Map()
      /** @type {Map<number, string>} full prompt text per rendered turn (edit dialog). */
      const fullByTurn = new Map()
      /** @type {null | (() => void)} */
      let closeEditor = null
      /** @type {null | (() => void)} */
      let closeVersions = null

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

      function closeCurrentEditor() {
        if (closeEditor === null) return
        const close = closeEditor
        closeEditor = null
        close()
      }

      function closeCurrentVersions() {
        if (closeVersions === null) return
        const close = closeVersions
        closeVersions = null
        close()
      }

      function formatTime(time) {
        if (typeof time !== 'number' || !Number.isFinite(time)) return ''
        const date = new Date(time)
        const pad = value => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      }

      /**
       * Open the 「历史版本」 dialog for one user row: every assistant answer of
       * this prompt that was hidden by a regenerate / edit / rewind. Continuing
       * from a version forks the session at that answer's seq (`sessions.fork`)
       * and opens the child, so the current conversation is left untouched.
       */
      async function openVersions(turn, promptText) {
        if (sessionId === undefined || closeVersions !== null) return
        let payload
        try {
          payload = await postJson(VERSIONS_PATH, { sessionId })
        } catch (error) {
          window.alert(`读取历史版本失败：${String(error?.message ?? error)}`)
          return
        }
        if (payload?.ok !== true) {
          window.alert(`读取历史版本失败：${payload?.error?.message ?? payload?.error?.code ?? '未知错误'}`)
          return
        }
        const versions = (payload.versions ?? []).filter(version => version?.promptText === promptText)
        if (versions.length === 0) {
          window.alert('这个提问还没有历史回答：重新生成一次后，旧回答会出现在这里')
          return
        }
        showVersionsModal(turn, versions)
      }

      function showVersionsModal(turn, versions) {
        const overlay = document.createElement('div')
        overlay.setAttribute('data-conversation-flow-versions', '1')
        overlay.style.cssText = [
          'position:fixed',
          'inset:0',
          'z-index:2147483201',
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'padding:24px',
          'background:rgba(0,0,0,.45)',
        ].join(';')
        const card = document.createElement('div')
        card.style.cssText = [
          'box-sizing:border-box',
          'width:min(760px,94vw)',
          'max-height:88vh',
          'overflow:auto',
          'padding:18px',
          'border-radius:12px',
          'background:#1b1d21',
          'color:#e8e8e8',
          'box-shadow:0 18px 48px rgba(0,0,0,.5)',
          'font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif',
          'border:1px solid rgba(255,255,255,.14)',
        ].join(';')
        const title = document.createElement('h3')
        title.style.cssText = 'margin:0 0 6px;font-size:15px;font-weight:600'
        title.textContent = `第 ${turn} 轮提问的历史回答（${versions.length} 个版本）`
        const hint = document.createElement('p')
        hint.style.cssText = 'margin:0 0 4px;font-size:12px;opacity:.65'
        hint.textContent = '旧回答只用于查看和选择，不会加入当前对话的上下文；日志仍保留。切换版本只会在新分支中进行——原会话连同它后面的对话都保持完整，不会出现「把第 5 轮换成第 4 版，导致 6-9 轮全部失效」的情况。'
        card.append(title, hint)

        let closed = false
        function close() {
          if (closed) return
          closed = true
          document.removeEventListener('keydown', onKey)
          overlay.remove()
          if (closeVersions === close) closeVersions = null
        }
        function onKey(event) {
          if (event.key === 'Escape') close()
        }

        function button(label, primary) {
          const element = document.createElement('button')
          element.type = 'button'
          element.textContent = label
          element.style.cssText = primary
            ? 'padding:5px 12px;border-radius:6px;border:0;background:#3b82f6;color:#fff;cursor:pointer;font-weight:600;font-size:12px'
            : 'padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;cursor:pointer;font-size:12px'
          return element
        }

        async function continueFrom(version, target) {
          if (sessionId === undefined) return
          const ok = window.confirm(
            `从第 ${versions.indexOf(version) + 1} 版回答新建分支并继续？\n\n• 新分支从这一版回答处接续；原会话保持完整（这一版之后的对话不会被改动或失效）\n• 旧回答不会被加入当前会话的上下文\n• 工作区文件不会回滚，保持当前状态`,
          )
          if (!ok) return
          if (typeof sessions?.fork !== 'function') {
            window.alert('当前 DSH 版本不支持创建分支，请先升级 DSH')
            return
          }
          target.disabled = true
          try {
            const childId = await sessions.fork({ sessionId, atSeq: version.answerSeq, increaseTitle: true })
            close()
            let uiWorkspace
            try {
              uiWorkspace = ctx.get('uiWorkspace')
            } catch {
              uiWorkspace = undefined
            }
            if (uiWorkspace?.openSession !== undefined) uiWorkspace.openSession(childId)
            else window.alert('已创建分支会话，但无法自动切换：请在左侧会话列表中打开新会话')
          } catch (error) {
            window.alert(`创建分支失败：${String(error?.message ?? error)}`)
          } finally {
            target.disabled = false
          }
        }

        versions.forEach((version, index) => {
          const block = document.createElement('section')
          block.style.cssText = [
            'margin-top:12px',
            'padding:12px',
            'border-radius:8px',
            'background:rgba(255,255,255,.04)',
            'border:1px solid rgba(255,255,255,.08)',
          ].join(';')
          const head = document.createElement('div')
          head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px'
          const label = document.createElement('b')
          label.style.cssText = 'font-size:13px;flex:1'
          const time = formatTime(version.time)
          label.textContent = `第 ${index + 1} 版${time === '' ? '' : ` · ${time}`}`
          const copyButton = button('复制')
          copyButton.addEventListener('click', () => {
            const clipboard = navigator.clipboard
            const done = () => {
              copyButton.textContent = '已复制'
              setTimeout(() => {
                copyButton.textContent = '复制'
              }, 1200)
            }
            if (clipboard?.writeText !== undefined) {
              void clipboard.writeText(version.text).then(done).catch(() => window.alert('复制失败'))
            } else {
              const helper = document.createElement('textarea')
              helper.value = version.text
              document.body.appendChild(helper)
              helper.select()
              try {
                document.execCommand('copy')
                done()
              } catch {
                window.alert('复制失败')
              }
              helper.remove()
            }
          })
          const continueButton = button('新建分支并继续', true)
          continueButton.addEventListener('click', () => {
            void continueFrom(version, continueButton)
          })
          head.append(label, copyButton, continueButton)
          const body = document.createElement('pre')
          body.textContent = version.text
          body.style.cssText = [
            'margin:0',
            'max-height:34vh',
            'overflow:auto',
            'white-space:pre-wrap',
            'word-break:break-word',
            'font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace',
            'opacity:.92',
          ].join(';')
          block.append(head, body)
          card.appendChild(block)
        })

        const footer = document.createElement('div')
        footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:16px'
        const closeButton = button('关闭')
        closeButton.addEventListener('click', () => close())
        footer.appendChild(closeButton)
        card.appendChild(footer)
        overlay.appendChild(card)
        overlay.addEventListener('mousedown', event => {
          if (event.target === overlay) close()
        })
        document.addEventListener('keydown', onKey)
        closeVersions = close
        document.body.appendChild(overlay)
      }

      /**
       * Edit-and-resend dialog: pre-fill the original prompt, let the user pick
       * what happens to the discarded future, then cut + (optionally) restore
       * files + send the edited text. "Archive" first forks the whole current
       * conversation into a branch, so the future leaves an audit trail.
       */
      function openEditor(turn, seq) {
        if (sessionId === undefined || closeEditor !== null) return
        const original = fullByTurn.get(turn) ?? ''
        const overlay = document.createElement('div')
        overlay.setAttribute('data-conversation-flow-editor', '1')
        overlay.style.cssText = [
          'position:fixed',
          'inset:0',
          'z-index:2147483200',
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'padding:24px',
          'background:rgba(0,0,0,.45)',
        ].join(';')
        const card = document.createElement('div')
        card.style.cssText = [
          'box-sizing:border-box',
          'width:min(680px,94vw)',
          'max-height:88vh',
          'overflow:auto',
          'padding:18px',
          'border-radius:12px',
          'background:#1b1d21',
          'color:#e8e8e8',
          'box-shadow:0 18px 48px rgba(0,0,0,.5)',
          'font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif',
          'border:1px solid rgba(255,255,255,.14)',
        ].join(';')

        const title = document.createElement('h3')
        title.style.cssText = 'margin:0 0 6px;font-size:15px;font-weight:600'
        title.textContent = `编辑并重新发送（第 ${turn} 轮）`
        const hint = document.createElement('p')
        hint.style.cssText = 'margin:0 0 12px;font-size:12px;opacity:.65'
        hint.textContent = '修改这条提问后重新发送；附件不会自动带入新消息。'
        const textarea = document.createElement('textarea')
        textarea.value = original
        textarea.spellcheck = false
        textarea.style.cssText = [
          'box-sizing:border-box',
          'width:100%',
          'min-height:140px',
          'max-height:46vh',
          'resize:vertical',
          'padding:10px 12px',
          'border-radius:8px',
          'border:1px solid rgba(255,255,255,.18)',
          'background:rgba(0,0,0,.25)',
          'color:inherit',
          'font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace',
          'outline:none',
        ].join(';')

        const choices = document.createElement('div')
        choices.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:14px;font-size:13px'
        for (const choice of EDIT_CHOICES) {
          const label = document.createElement('label')
          label.style.cssText = 'display:flex;gap:8px;align-items:flex-start;cursor:pointer'
          const radio = document.createElement('input')
          radio.type = 'radio'
          radio.name = 'flow-editor-choice'
          radio.value = choice.value
          radio.checked = choice.value === 'delete'
          radio.style.cssText = 'margin:3px 0 0'
          const body = document.createElement('span')
          const head = document.createElement('b')
          head.textContent = choice.label
          const sub = document.createElement('span')
          sub.style.cssText = 'display:block;font-size:12px;opacity:.6'
          sub.textContent = choice.hint
          body.append(head, sub)
          label.append(radio, body)
          choices.appendChild(label)
        }

        const footer = document.createElement('div')
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px'
        const cancelButton = document.createElement('button')
        cancelButton.type = 'button'
        cancelButton.textContent = '取消'
        cancelButton.style.cssText = [
          'padding:6px 14px',
          'border-radius:6px',
          'border:1px solid rgba(255,255,255,.18)',
          'background:transparent',
          'color:inherit',
          'cursor:pointer',
        ].join(';')
        const sendButton = document.createElement('button')
        sendButton.type = 'button'
        sendButton.textContent = '重新发送'
        sendButton.style.cssText = [
          'padding:6px 14px',
          'border-radius:6px',
          'border:0',
          'background:#3b82f6',
          'color:#fff',
          'cursor:pointer',
          'font-weight:600',
        ].join(';')
        footer.append(cancelButton, sendButton)
        card.append(title, hint, textarea, choices, footer)
        overlay.appendChild(card)

        let closed = false
        let busy = false
        function close() {
          if (closed) return
          closed = true
          document.removeEventListener('keydown', onKey)
          overlay.remove()
          if (closeEditor === close) closeEditor = null
        }
        function onKey(event) {
          if (event.key === 'Escape') close()
        }

        async function submit() {
          if (busy || sessionId === undefined) return
          const content = textarea.value
          if (content.trim() === '') {
            window.alert('编辑后的内容不能为空')
            return
          }
          const selected = card.querySelector('input[name="flow-editor-choice"]:checked')
          const choice = typeof selected?.value === 'string' ? selected.value : 'delete'
          busy = true
          sendButton.disabled = true
          cancelButton.disabled = true
          try {
            if (choice === 'archive') {
              if (typeof sessions?.fork !== 'function') {
                window.alert('当前 DSH 版本不支持自动创建分支，请选「删除后续并重发」或「保留文件改动后重发」')
                return
              }
              try {
                await sessions.fork({ sessionId, increaseTitle: true })
              } catch (error) {
                window.alert(`归档分支失败：${String(error?.message ?? error)}`)
                return
              }
            }
            const result = await postJson(EXECUTE_PATH, {
              sessionId,
              targetSeq: seq,
              mode: 'edit',
              content,
              restore: choice !== 'keep',
            })
            if (result?.ok !== true) {
              window.alert(`操作失败：${result?.error?.message ?? result?.error?.code ?? '未知错误'}`)
              return
            }
            if (result.edit?.sent !== true) {
              window.alert(`对话已回退，但重发失败：${result.edit?.error ?? '未知错误'}`)
            }
            if (result.restore?.error !== undefined) {
              window.alert(`对话已回退，但文件恢复不可用：${result.restore.message ?? result.restore.error}`)
            }
            close()
            await sessions?.refresh?.()
            schedule()
          } catch (error) {
            window.alert(`操作失败：${String(error?.message ?? error)}`)
          } finally {
            busy = false
            sendButton.disabled = false
            cancelButton.disabled = false
          }
        }

        cancelButton.addEventListener('click', () => close())
        sendButton.addEventListener('click', () => {
          void submit()
        })
        overlay.addEventListener('mousedown', event => {
          if (event.target === overlay) close()
        })
        document.addEventListener('keydown', onKey)
        closeEditor = close
        document.body.appendChild(overlay)
        textarea.focus()
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
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
        const promptByTurn = new Map()
        fullByTurn.clear()
        for (const turn of status.turns ?? []) {
          if (Number.isSafeInteger(turn?.turn) && Number.isSafeInteger(turn?.userSeq)) {
            seqByTurn.set(turn.turn, turn.userSeq)
            if (typeof turn.promptFull === 'string') fullByTurn.set(turn.turn, turn.promptFull)
            if (typeof turn.promptText === 'string') promptByTurn.set(turn.turn, turn.promptText)
          }
        }
        const versionCountByPrompt = new Map()
        for (const entry of status.versionCounts ?? []) {
          if (typeof entry?.promptText === 'string' && Number.isSafeInteger(entry?.count) && entry.count > 0) {
            versionCountByPrompt.set(entry.promptText, entry.count)
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
          const promptText = promptByTurn.get(turn)
          const versionCount = promptText === undefined ? 0 : (versionCountByPrompt.get(promptText) ?? 0)
          const panel = panelFor(
            mode => {
              if (mode === 'edit') openEditor(turn, seq)
              else void run(mode, turn, seq)
            },
            versionCount,
            promptText === undefined ? undefined : () => {
              void openVersions(turn, promptText)
            },
          )
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
          if (nextSessionId !== sessionId) {
            closeCurrentEditor()
            closeCurrentVersions()
          }
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
        closeCurrentEditor()
        closeCurrentVersions()
        window.__dshConversationFlowClientMounted = false
      }
    }

    return { inject: ['sessions', 'contextMenus'], apply }
  },
})
