import { app, BrowserWindow, shell, nativeTheme, ipcMain, Tray, Menu, nativeImage } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

process.env.OHMYCODEX_ELECTRON = '1'
process.env.OPENCODEX_ELECTRON = '1'

const PORT = 16868

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let serverModule: any = null
let isQuitting = false

function getBg() {
  return nativeTheme.shouldUseDarkColors ? '#0c0c14' : '#f5f5f7'
}

// ─── Tray ───────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '../build/tray/icon-tray-template.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('OhMyCodex')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开窗口',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: '完全退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  // Left-click → open window only (no menu)
  tray.on('click', () => showWindow())

  // Right-click → popup context menu
  tray.on('right-click', () => {
    tray!.popUpContextMenu(contextMenu)
  })
}

function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
  // Show in dock when window is visible
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show()
  }
}

// ─── Window ─────────────────────────────────────────────────

function createWindow() {
  const isMac = process.platform === 'darwin'

  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: 1200,
    height: 780,
    minWidth: 800,
    minHeight: 520,
    backgroundColor: getBg(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }

  // macOS: hidden inset title bar with traffic lights
  if (isMac) {
    winOpts.titleBarStyle = 'hiddenInset'
    winOpts.trafficLightPosition = { x: 16, y: 16 }
    winOpts.roundedCorners = true
    winOpts.vibrancy = 'under-window'
    winOpts.visualEffectState = 'active'
  } else {
    winOpts.frame = true
  }

  mainWindow = new BrowserWindow(winOpts)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }

  // Close → hide window (not quit); hide from Dock
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
      if (isMac && app.dock) {
        app.dock.hide()
      }
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ─── App Lifecycle ──────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    serverModule = await import('../dist/server.js') as any
    serverModule.startHttpServer()
    console.log(`[OhMyCodex] Gateway on :${PORT}`)
    console.log('[OhMyCodex] Ready')
  } catch (err) {
    console.error('[OhMyCodex] Server error:', err)
  }

  createTray()
  createWindow()
  app.on('activate', () => { showWindow() })
})

app.on('window-all-closed', () => {
  // macOS: keep running in tray; Windows/Linux: quit
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  mainWindow?.destroy()
  mainWindow = null
})

nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(getBg()))
