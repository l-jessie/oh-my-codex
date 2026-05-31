import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ohmycodexLogo from './assets/ohmycodex-logo.png'

const PORT = 16868
const BASE = `http://127.0.0.1:${PORT}`

type LogLine = { time: string; tag: string; text: string; level: string }
type Lang = 'zh' | 'en'
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type VisionMode = 'default' | 'custom'

type Profile = {
  uuidId: string
  name: string
  base_url: string
  api_key: string
  models: string // newline-separated
  vision_mode: VisionMode
  vision_model: string
  vision_base_url: string
  vision_api_key: string
}

const emptyProfile = (name = 'Default'): Profile => ({
  uuidId: '',
  name,
  base_url: '',
  api_key: '',
  models: '',
  vision_mode: 'default',
  vision_model: '',
  vision_base_url: '',
  vision_api_key: '',
})

// Load profiles from server API
const loadProfilesFromServer = async (): Promise<{ profiles: Profile[]; activeUuidId: string }> => {
  try {
    const res = await fetch(`${BASE}/api/providers`)
    if (!res.ok) throw new Error("fetch failed")
    const data = await res.json()
    const profiles: Profile[] = (data.providers || []).map((p: any) => ({
      uuidId: p.uuidId || p.id || '',
      name: p.name || 'Untitled',
      base_url: p.base_url || '',
      api_key: p.api_key || '',
      models: (p.models || []).join('\n'),
      vision_mode: p.vision?.mode || 'default',
      vision_model: p.vision?.model || '',
      vision_base_url: p.vision?.base_url || '',
      vision_api_key: p.vision?.api_key || '',
    }))
    const activeUuidId = data.active_uuidId || data.active_id || profiles[0]?.uuidId || ''
    return { profiles: profiles.length > 0 ? profiles : [emptyProfile()], activeUuidId }
  } catch {
    const def = emptyProfile()
    return { profiles: [def], activeUuidId: def.uuidId }
  }
}

// Save a single provider to server
const saveProviderToServer = async (profile: Profile, setActive?: boolean): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuidId: profile.uuidId || undefined,
        name: profile.name,
        base_url: profile.base_url,
        api_key: profile.api_key, // Empty string means "keep existing"
        models: profile.models.split('\n').map(s => s.trim()).filter(Boolean),
        vision: {
          mode: profile.vision_mode,
          model: profile.vision_model,
          base_url: profile.vision_base_url,
          api_key: profile.vision_api_key,
        },
      }),
    })
    const data = await res.json()
    if (setActive && (data.uuidId || data.id)) {
      await fetch(`${BASE}/api/providers/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuidId: data.uuidId || data.id }),
      })
    }
    return data.status === 'success'
  } catch { return false }
}

// Delete a provider from server
const deleteProviderFromServer = async (uuidId: string): Promise<boolean> => {
  try {
    console.log('[DELETE] Requesting delete for:', uuidId)
    const res = await fetch(`${BASE}/api/providers/${uuidId}`, { method: 'DELETE' })
    const data = await res.json()
    console.log('[DELETE] Response:', res.status, data)
    return data.status === 'success'
  } catch (e) { console.error('[DELETE] Error:', e); return false }
}

const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    appName: 'OhMyCodex',
    gatewayRunning: '网关运行中',
    connecting: '连接中...',
    reconnecting: '重连中...',
    events: '条事件',
    restart: '重启 Codex',
    reset: '还原原生',
    settings: '设置',
    liveLog: '实时日志大屏',
    pause: '⏸ 暂停',
    resume: '▶ 继续',
    clear: '清空',
    level: '级别',
    levelDebug: '调试',
    levelInfo: '信息',
    levelWarn: '警告',
    levelError: '错误',
    waitingLogs: '等待日志流...',
    gatewayOnPort: '网关已在 {port} 端口运行',
    profileLabel: '厂商配置',
    profileNew: '新建',
    profileDelete: '删除',
    profileRename: '配置名称',
    profilePlaceholder: '例如：DeepSeek / SiliconFlow',
    confirmDeleteProfile: '确定删除配置「{name}」吗？',
    api: 'API 配置',
    baseUrl: 'Base URL',
    apiKey: 'API Key',
    modelsLabel: '模型（每行一个）',
    fetchModels: '拉取模型列表',
    fetching: '拉取中...',
    vision: '视觉模型',
    visionDefault: '默认（复用上方）',
    visionCustom: '自定义',
    visionModel: '视觉模型',
    visionPickHint: '请选择视觉模型',
    noModelsYet: '请先在上方填写并拉取模型列表',
    autoRestart: '保存后自动重启 Codex',
    saveConfig: '保存配置并更新 Codex 菜单',
    cancel: '取消',
    confirm: '确认',
    resetWarning: '还原后 Codex 显示官方模型，自定义模型的对话将被隐藏。重新填写 API 即可恢复。',
    toastFillUrl: '请先填写 Base URL',
    toastFillKey: '请先填写 API Key',
    toastFetchOk: '已获取 {n} 个模型',
    toastFetchFail: '获取失败，请检查 URL 和 Key',
    toastNoModels: '未获取到模型',
    toastRestarting: '正在重启 Codex Desktop...',
    toastRestarted: 'Codex 已重启',
    toastSaved: '配置已保存',
    toastSaveFail: '保存失败',
    toastConnFail: '连接失败',
    toastResetting: '正在还原...',
    toastResetDone: '还原完成',
    toastResetFail: '还原失败',
    toastRestartFail: '重启失败',
    toastLevelSet: '日志级别已切换为 {lvl}',
    toastNoModelsForCodex: '请先在「API 配置」中填写至少一个模型',
    toastPickVision: '请先选择视觉模型',
    toastProfileCreated: '已新建配置',
    toastProfileDeleted: '已删除配置',
    toastProfileSwitched: '已切换为「{name}」',
    placeholderUrl: 'https://api.example.com/v1',
    placeholderKey: 'sk-...',
    paused: ' 条新日志',
  },
  en: {
    appName: 'OhMyCodex',
    gatewayRunning: 'Gateway Running',
    connecting: 'Connecting...',
    reconnecting: 'Reconnecting...',
    events: 'events',
    restart: 'Restart Codex',
    reset: 'Reset Native',
    settings: 'Settings',
    liveLog: 'Live Log Cockpit',
    pause: '⏸ Pause',
    resume: '▶ Resume',
    clear: 'Clear',
    level: 'Level',
    levelDebug: 'Debug',
    levelInfo: 'Info',
    levelWarn: 'Warn',
    levelError: 'Error',
    waitingLogs: 'Waiting for log stream...',
    gatewayOnPort: 'Gateway running on port {port}',
    profileLabel: 'Provider',
    profileNew: 'New',
    profileDelete: 'Delete',
    profileRename: 'Profile name',
    profilePlaceholder: 'e.g. DeepSeek / SiliconFlow',
    confirmDeleteProfile: 'Delete profile "{name}"?',
    api: 'API Config',
    baseUrl: 'Base URL',
    apiKey: 'API Key',
    modelsLabel: 'Models (one per line)',
    fetchModels: 'Fetch model list',
    fetching: 'Fetching...',
    vision: 'Vision Model',
    visionDefault: 'Default (reuse above)',
    visionCustom: 'Custom',
    visionModel: 'Vision Model',
    visionPickHint: 'Pick a vision model',
    noModelsYet: 'Add models in API Config first',
    autoRestart: 'Auto-restart Codex after save',
    saveConfig: 'Save & Update Codex Menu',
    cancel: 'Cancel',
    confirm: 'Confirm',
    resetWarning: 'After reset, Codex shows official models; custom-model chats are hidden. Re-enter API to restore.',
    toastFillUrl: 'Please fill in Base URL first',
    toastFillKey: 'Please fill in API Key first',
    toastFetchOk: 'Fetched {n} models',
    toastFetchFail: 'Fetch failed, please check URL and Key',
    toastNoModels: 'No models retrieved',
    toastRestarting: 'Restarting Codex Desktop...',
    toastRestarted: 'Codex restarted',
    toastSaved: 'Config saved',
    toastSaveFail: 'Save failed',
    toastConnFail: 'Connection failed',
    toastResetting: 'Resetting...',
    toastResetDone: 'Reset complete',
    toastResetFail: 'Reset failed',
    toastRestartFail: 'Restart failed',
    toastLevelSet: 'Log level switched to {lvl}',
    toastNoModelsForCodex: 'Add at least one model in API Config first',
    toastPickVision: 'Please pick a vision model first',
    toastProfileCreated: 'Profile created',
    toastProfileDeleted: 'Profile deleted',
    toastProfileSwitched: 'Switched to "{name}"',
    placeholderUrl: 'https://api.example.com/v1',
    placeholderKey: 'sk-...',
    paused: ' new',
  },
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem('ohmycodex.lang') as Lang) || 'zh' } catch { return 'zh' }
  })
  const t = useCallback((k: string, vars?: Record<string, any>) => {
    let s = I18N[lang][k] || k
    if (vars) for (const [vk, vv] of Object.entries(vars)) s = s.replace(`{${vk}}`, String(vv))
    return s
  }, [lang])

  useEffect(() => { try { localStorage.setItem('ohmycodex.lang', lang) } catch {} }, [lang])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logPaused, setLogPaused] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchingVision, setFetchingVision] = useState(false)
  const [autoRestart, setAutoRestart] = useState(() => {
    try { return localStorage.getItem('ohmycodex.autoRestart') !== 'false' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ohmycodex.autoRestart', String(autoRestart)) } catch {} }, [autoRestart])

  // ─── Profiles (server-based) ───
  const [profiles, setProfiles] = useState<Profile[]>([emptyProfile()])
  const [activeUuidId, setActiveUuidId] = useState<string>('')
  const active = profiles.find(p => p.uuidId === activeUuidId) || profiles[0]
  const [visionModelList, setVisionModelList] = useState<string[]>([])

  // Load profiles from server on mount
  useEffect(() => {
    (async () => {
      const { profiles: loaded, activeUuidId: loadedActive } = await loadProfilesFromServer()
      setProfiles(loaded)
      setActiveUuidId(loadedActive)
    })()
  }, [])



  const updateActive = (patch: Partial<Profile>) => {
    setProfiles(prev => prev.map(p => p.uuidId === activeUuidId ? { ...p, ...patch } : p))
  }

  const addProfile = async () => {
    const p = emptyProfile(`Provider ${profiles.length + 1}`)
    const ok = await saveProviderToServer(p, true)
    if (ok) {
      // Reload from server to get the real uuidId
      const { profiles: loaded, activeUuidId: loadedActive } = await loadProfilesFromServer()
      setProfiles(loaded)
      setActiveUuidId(loadedActive)
      setVisionModelList([])
      showToast(t('toastProfileCreated'))
    }
  }

  const deleteProfile = () => {
    console.log('[DELETE] deleteProfile called, profiles:', profiles.length, 'activeUuidId:', activeUuidId)
    if (profiles.length <= 1) return
    const targetId = activeUuidId
    const targetName = active?.name || ''
    if (!targetId) return
    setConfirmModal({
      msg: t('confirmDeleteProfile', { name: targetName }),
      onOk: () => {
        console.log('[DELETE] onOk called, targetId:', targetId)
        deleteProviderFromServer(targetId).then(ok => {
          console.log('[DELETE] deleteProviderFromServer result:', ok)
          if (ok) {
            // Reload from server
            loadProfilesFromServer().then(({ profiles: loaded, activeUuidId: loadedActive }) => {
              console.log('[DELETE] Reloaded profiles:', loaded.length, 'active:', loadedActive)
              setProfiles(loaded)
              setActiveUuidId(loadedActive)
              setVisionModelList([])
              showToast(t('toastProfileDeleted'))
            })
          }
        })
      },
    })
  }

  const switchProfile = async (id: string) => {
    setActiveUuidId(id)
    setVisionModelList([])
    await fetch(`${BASE}/api/providers/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuidId: id }),
    })
    const p = profiles.find(x => x.uuidId === id)
    if (p) showToast(t('toastProfileSwitched', { name: p.name }))
  }

  // ─── Logs ───
  const [logs, setLogs] = useState<LogLine[]>([])
  const [logLevel, setLogLevel] = useState<LogLevel>('info')
  const [sseStatus, setSseStatus] = useState<'connecting' | 'connected' | 'lost'>('connecting')
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [confirmModal, setConfirmModal] = useState<{ msg: string; onOk: () => void } | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)
  const logsRef = useRef<LogLine[]>([])
  const pausedLogsRef = useRef<LogLine[]>([])
  const logPausedRef = useRef(false)
  useEffect(() => { logPausedRef.current = logPaused }, [logPaused])

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const fetchJSON = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${path}`, init)
    return res.json()
  }, [])

  // Load saved log level + (one-time) hydrate models textarea from server-side catalog if profile empty
  useEffect(() => {
    (async () => {
      try {
        const levelData = await fetchJSON('/api/log-level').catch(() => null)
        if (levelData?.level) setLogLevel(levelData.level)
      } catch {}

    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SSE log stream — reconnects automatically (skip in Electron, use IPC instead)
  const _isElectron = true // Always use HTTP polling instead of SSE
  useEffect(() => {
    if (_isElectron) return; // IPC handles logs in Electron
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      es = new EventSource(`${BASE}/api/logs/stream`)
      es.onopen = () => setSseStatus('connected')
      es.onmessage = (e) => {
        try {
          const log = JSON.parse(e.data)
          logsRef.current = [...logsRef.current.slice(-999), log]
          if (logPausedRef.current) { pausedLogsRef.current = [...pausedLogsRef.current, log] }
          else { setLogs([...logsRef.current]) }
        } catch {}
      }
      es.onerror = () => {
        setSseStatus('lost')
        es?.close()
        retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => { es?.close(); if (retry) clearTimeout(retry) }
  }, []) // open ONCE — pause is read via ref so we don't reconnect on every toggle

  // Log polling: works in both Electron (packaged) and browser environments
  useEffect(() => {
    let lastIndex = 0
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}/api/logs/since?index=${lastIndex}`)
        if (!res.ok) return
        const data = await res.json()
        if (data.logs?.length > 0) {
          lastIndex = data.nextIndex
          logsRef.current = [...logsRef.current.slice(-999), ...data.logs].slice(-1000)
          if (logPausedRef.current) {
            pausedLogsRef.current = [...pausedLogsRef.current, ...data.logs]
          } else {
            setLogs([...logsRef.current])
          }
          setSseStatus('connected')
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 200)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!logPaused && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight
  }, [logs, logPaused])

  const changeLogLevel = async (lvl: LogLevel) => {
    setLogLevel(lvl)
    try {
      await fetchJSON('/api/log-level', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: lvl }),
      })
      showToast(t('toastLevelSet', { lvl: t('level' + lvl[0].toUpperCase() + lvl.slice(1)) }))
    } catch { showToast(t('toastSaveFail'), true) }
  }

  const doFetchModels = async (base: string, key: string): Promise<string[]> => {
    if (!base.trim()) { showToast(t('toastFillUrl'), true); return [] }
    if (!key.trim()) { showToast(t('toastFillKey'), true); return [] }
    const res = await fetchJSON('/api/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: base, api_key: key }),
    })
    if (res.error) { showToast(res.error, true); return [] }
    if (!res.models?.length) { showToast(t('toastNoModels'), true); return [] }
    showToast(t('toastFetchOk', { n: res.models.length }))
    return res.models
  }

  const fetchProviderModels = async () => {
    if (!active) return
    setFetchingModels(true)
    try {
      const list = await doFetchModels(active.base_url, active.api_key)
      if (list.length) updateActive({ models: list.join('\n') })
    } catch { showToast(t('toastFetchFail'), true) }
    finally { setFetchingModels(false) }
  }

  const fetchVisionModelList = async () => {
    if (!active) return
    setFetchingVision(true)
    try {
      const list = await doFetchModels(active.vision_base_url, active.vision_api_key)
      if (list.length) {
        setVisionModelList(list)
        if (!list.includes(active.vision_model)) updateActive({ vision_model: list[0] })
      }
    } catch { showToast(t('toastFetchFail'), true) }
    finally { setFetchingVision(false) }
  }

  const defaultVisionOptions = useMemo(
    () => (active?.models || '').split('\n').map(s => s.trim()).filter(Boolean),
    [active?.models]
  )

  const saveConfig = async () => {
    if (!active) return
    const modelArr = active.models.split('\n').map(s => s.trim()).filter(Boolean)
    if (modelArr.length === 0) { showToast(t('toastNoModelsForCodex'), true); return }

    const finalVisionModel = active.vision_mode === 'default'
      ? (active.vision_model || modelArr[0])
      : active.vision_model
    if (!finalVisionModel) { showToast(t('toastPickVision'), true); return }

    try {
      if (autoRestart) showToast(t('toastRestarting'))
      // Save current provider to server
      const providerData: any = {
        uuidId: active.uuidId || undefined,
        name: active.name || 'custom',
        base_url: active.base_url,
        api_key: active.api_key,
        models: modelArr,
      }
      // Vision config — always send mode so "default" selection persists
      providerData.vision = {
        mode: active.vision_mode || 'default',
        model: finalVisionModel,
        base_url: active.vision_mode === 'custom' ? active.vision_base_url : '',
        api_key: active.vision_mode === 'custom' ? active.vision_api_key : '',
      }

      const res = await fetch(`${BASE}/api/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerData),
      })
      const data = await res.json()
      if (data.status === 'success') {
        // Also save to legacy /api/config for Codex integration
        // NOTE: Do NOT send ohmycodex here — vision config is already saved
        // via /api/providers above.  Sending it here would overwrite the
        // vision mode (the legacy handler used to hardcode mode:"custom").
        await fetchJSON('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            primary: { name: providerData.name, api_key: active.api_key, base_url: active.base_url },
            models: modelArr,
            restart: autoRestart,
          }),
        })
        showToast(autoRestart ? t('toastRestarted') : t('toastSaved'))
      } else showToast(t('toastSaveFail'), true)
    } catch { showToast(t('toastConnFail'), true) }
  }

  const restartCodex = async () => {
    showToast(t('toastRestarting'))
    try { await fetchJSON('/api/restart-codex', { method: 'POST' }); setTimeout(() => showToast(t('toastRestarted')), 2500) }
    catch { showToast(t('toastRestartFail'), true) }
  }

  const resetCodex = () => {
    setConfirmModal({
      msg: t('resetWarning'),
      onOk: async () => {
        showToast(t('toastResetting'))
        try { await fetchJSON('/api/reset', { method: 'POST' }); setTimeout(() => showToast(t('toastResetDone')), 2500) }
        catch { showToast(t('toastResetFail'), true) }
      },
    })
  }

  const togglePause = () => {
    if (logPaused) { logsRef.current = [...logsRef.current, ...pausedLogsRef.current]; setLogs([...logsRef.current]); pausedLogsRef.current = [] }
    setLogPaused(!logPaused)
  }

  const statusText = useMemo(() => {
    if (sseStatus === 'connected') return t('gatewayRunning')
    if (sseStatus === 'connecting') return t('connecting')
    return t('reconnecting')
  }, [sseStatus, t])

  const levelLabel = (l: LogLevel) => t('level' + l[0].toUpperCase() + l.slice(1))

  return (
    <div className="app">
      <div className="drag-region" />

      <header className="header">
        <div className="header-left">
          <div className="logo" aria-hidden>
            <img src={ohmycodexLogo} alt="" />
          </div>
          <div className="header-info">
            <h1 className="app-name">{t('appName')}</h1>
            <div className="status-line">
              <span className={`status-dot ${sseStatus === 'connected' ? 'dot-ok' : 'dot-warn'}`} />
              <span className="status-text">{statusText}</span>
  <span className="log-count">{logs.length} {t('events')}</span>
            </div>
          </div>
        </div>
        <div className="header-right">
          <div className="lang-switch" role="tablist" aria-label="language">
            <button className={`lang-btn ${lang === 'zh' ? 'lang-on' : ''}`} onClick={() => setLang('zh')}>中</button>
            <button className={`lang-btn ${lang === 'en' ? 'lang-on' : ''}`} onClick={() => setLang('en')}>EN</button>
          </div>
          <button className="icon-text-btn" onClick={restartCodex} title={t('restart')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 019.3-3.95l.7.7V2.5a.5.5 0 011 0v4a.5.5 0 01-.5.5h-4a.5.5 0 010-1h2.25l-.7-.7A4.5 4.5 0 003.5 8a.5.5 0 01-1 0z" fill="currentColor"/><path d="M13.5 8a5.5 5.5 0 01-9.3 3.95l-.7-.7v2.25a.5.5 0 01-1 0v-4a.5.5 0 01.5-.5h4a.5.5 0 010 1H4.75l.7.7A4.5 4.5 0 0012.5 8a.5.5 0 011 0z" fill="currentColor"/></svg>
            <span>{t('restart')}</span>
          </button>
          <button className="icon-text-btn btn-danger" onClick={resetCodex} title={t('reset')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4.5 2a.5.5 0 00-.5.5v3a.5.5 0 00.5.5h3a.5.5 0 000-1H5V2.5a.5.5 0 00-.5-.5zM8 14a6 6 0 100-12 6 6 0 000 12zm0-1a5 5 0 110-10 5 5 0 010 10z" fill="currentColor" opacity=".8"/></svg>
            <span>{t('reset')}</span>
          </button>
          <div className="header-divider" />
          <button className={`settings-btn ${settingsOpen ? 'settings-btn-active' : ''}`} onClick={() => setSettingsOpen(!settingsOpen)}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 10a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" strokeWidth="1.2"/></svg>
            <span>{t('settings')}</span>
          </button>
        </div>
      </header>

      <main className="main">
        <div className="console-toolbar">
          <div className="console-toolbar-left">
            <span className="console-icon">📡</span>
            <span className="console-label">{t('liveLog')}</span>
          </div>
          <div className="console-toolbar-right">
            <div className="level-switch" title={t('level')}>
              <span className="level-label">{t('level')}</span>
              {LEVELS.map(l => (
                <button
                  key={l}
                  className={`level-btn level-${l} ${logLevel === l ? 'level-on' : ''}`}
                  onClick={() => changeLogLevel(l)}
                >{levelLabel(l)}</button>
              ))}
            </div>
            <button className={`toolbar-btn ${logPaused ? 'btn-paused' : ''}`} onClick={togglePause}>{logPaused ? t('resume') : t('pause')}</button>
            <button className="toolbar-btn" onClick={() => { logsRef.current = []; pausedLogsRef.current = []; setLogs([]) }}>{t('clear')}</button>
          </div>
        </div>
        <div className={`console-body ${logPaused ? 'console-paused' : ''}`} ref={consoleRef}>
          {logs.map((log, i) => (
            <div key={i} className={`log-line log-${log.level}`}>
              <span className="log-time">{log.time}</span>
              <span className="log-sep">│</span>
              <span className={`log-tag tag-${log.level}`}>{log.tag}</span>
              <span className="log-text">{log.text}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="log-empty">
              <div className="empty-icon">📡</div>
              <div>{t('waitingLogs')}</div>
              <div className="empty-sub">{t('gatewayOnPort', { port: PORT })}</div>
            </div>
          )}
        </div>
        {logPaused && pausedLogsRef.current.length > 0 && <div className="pause-badge">{pausedLogsRef.current.length}{t('paused')}</div>}
      </main>

      {settingsOpen && <div className="panel-overlay" onClick={() => setSettingsOpen(false)} />}
      <aside className={`settings-panel ${settingsOpen ? 'panel-open' : ''}`}>
        <div className="panel-header">
          <h2>{t('settings')}</h2>
          <button className="panel-close" onClick={() => setSettingsOpen(false)}>✕</button>
        </div>
        <div className="panel-body">

          {/* ─── Profile switcher ─── */}
          <div className="profile-bar">
            <select value={activeUuidId} onChange={e => switchProfile(e.target.value)}>
              {profiles.map(p => <option key={p.uuidId} value={p.uuidId}>{p.name || '(untitled)'}</option>)}
            </select>
            <button className="profile-icon-btn" onClick={addProfile} title={t('profileNew')}>＋</button>
            <button className="profile-icon-btn danger" onClick={deleteProfile} disabled={profiles.length <= 1} title={t('profileDelete')}>−</button>
          </div>

          {active && (
            <div className="profile-name-row">
              <label>{t('profileRename')}</label>
              <input type="text" value={active.name} onChange={e => updateActive({ name: e.target.value })} placeholder={t('profilePlaceholder')} />
            </div>
          )}

          {active?.uuidId && (
            <div className="uuid-row">
              <label>UUID</label>
              <code className="uuid-value">{active.uuidId}</code>
            </div>
          )}

          {/* ─── API 配置 ─── */}
          <section className="panel-section">
            <h3 className="section-title">{t('api')}</h3>
            <div className="field"><label>{t('baseUrl')}</label><input type="text" value={active?.base_url || ''} onChange={e => updateActive({ base_url: e.target.value })} placeholder={t('placeholderUrl')} /></div>
            <div className="field"><label>{t('apiKey')}</label><input type="password" value={active?.api_key || ''} onChange={e => updateActive({ api_key: e.target.value })} placeholder={t('placeholderKey')} /></div>
            <div className="field">
              <div className="field-header">
                <label>{t('modelsLabel')}</label>
                <button className={`fetch-btn ${fetchingModels ? 'fetch-loading' : ''}`} onClick={fetchProviderModels} disabled={fetchingModels}>
                  <span>{fetchingModels ? t('fetching') : t('fetchModels')}</span>
                </button>
              </div>
              <textarea value={active?.models || ''} onChange={e => updateActive({ models: e.target.value })} rows={5} placeholder={"deepseek-chat\ngpt-4o\nclaude-3.5-sonnet"} />
            </div>
          </section>

          {/* ─── 视觉模型 ─── */}
          <section className="panel-section">
            <h3 className="section-title">{t('vision')}</h3>
            <div className="vision-tabs">
              <button className={`vision-tab ${active?.vision_mode === 'default' ? 'tab-on' : ''}`} onClick={() => updateActive({ vision_mode: 'default' })}>{t('visionDefault')}</button>
              <button className={`vision-tab ${active?.vision_mode === 'custom' ? 'tab-on' : ''}`} onClick={() => updateActive({ vision_mode: 'custom' })}>{t('visionCustom')}</button>
            </div>

            {active?.vision_mode === 'default' && (
              <div className="field">
                <label>{t('visionModel')}</label>
                <select value={active.vision_model} onChange={e => updateActive({ vision_model: e.target.value })}>
                  <option value="">{defaultVisionOptions.length === 0 ? t('noModelsYet') : t('visionPickHint')}</option>
                  {defaultVisionOptions.map(m => <option key={m} value={m}>{m}</option>)}
                  {active.vision_model && !defaultVisionOptions.includes(active.vision_model) && <option value={active.vision_model}>{active.vision_model}</option>}
                </select>
              </div>
            )}

            {active?.vision_mode === 'custom' && (
              <>
                <div className="field"><label>{t('baseUrl')}</label><input type="text" value={active.vision_base_url} onChange={e => updateActive({ vision_base_url: e.target.value })} placeholder={t('placeholderUrl')} /></div>
                <div className="field"><label>{t('apiKey')}</label><input type="password" value={active.vision_api_key} onChange={e => updateActive({ vision_api_key: e.target.value })} placeholder={t('placeholderKey')} /></div>
                <div className="field">
                  <div className="field-header">
                    <label>{t('visionModel')}</label>
                    <button className={`fetch-btn ${fetchingVision ? 'fetch-loading' : ''}`} onClick={fetchVisionModelList} disabled={fetchingVision}>
                      <span>{fetchingVision ? t('fetching') : t('fetchModels')}</span>
                    </button>
                  </div>
                  <select value={active.vision_model} onChange={e => updateActive({ vision_model: e.target.value })}>
                    <option value="">{t('visionPickHint')}</option>
                    {visionModelList.map(m => <option key={m} value={m}>{m}</option>)}
                    {active.vision_model && !visionModelList.includes(active.vision_model) && <option value={active.vision_model}>{active.vision_model}</option>}
                  </select>
                </div>
              </>
            )}
          </section>

          {/* ─── Save ─── */}
          <section className="panel-section panel-footer">
            <label className="checkbox-row"><input type="checkbox" checked={autoRestart} onChange={e => setAutoRestart(e.target.checked)} /><span>{t('autoRestart')}</span></label>
            <button className="btn btn-primary full-width" onClick={saveConfig}>{t('saveConfig')}</button>
          </section>
        </div>
      </aside>

      {toast && <div className={`toast ${toast.error ? 'toast-err' : 'toast-ok'}`}>{toast.text}</div>}
      {confirmModal && (
        <div className="modal-bg" onClick={() => setConfirmModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <p>{confirmModal.msg}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmModal(null)}>{t('cancel')}</button>
              <button className="btn btn-primary" onClick={() => { Promise.resolve(confirmModal.onOk()).finally(() => setConfirmModal(null)) }}>{t('confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
