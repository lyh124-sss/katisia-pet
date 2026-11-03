const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  powerMonitor
} = require('electron')
const path = require('node:path')

// 你之前改好的窗口尺寸
const WINDOW_SIZE = 200
const CLICK_TOLERANCE = 4      // 位移不超过 4px 视为“点击”
const DRAG_INTERVAL = 16       // 约 60fps 更新拖拽位置

// 状态机参数
const IDLE_THRESHOLD_SECONDS = 5          // 无键鼠操作进入待机（你当前设为 5 秒）
const ACTIVITY_POLL_MS = 500               // 每 0.5 秒检查一次系统闲置时间
const WALK_DURATION_MIN = 4_000            // walk 状态持续 4~7 秒
const WALK_DURATION_MAX = 7_000
const IDLE_PAUSE_MIN = 3_000               // 停下后 idle 3~6 秒
const IDLE_PAUSE_MAX = 6_000

// 点击时随机选一条：文字和语音必须一一对应
const SPEECHES = [
  {
    text: '别总盯着我看啦~',
    voice: 'assets/voice4.mp3'
  },
  {
    text: '记得多喝水哦',
    voice: 'assets/voice3.mp3'
  },
  {
    text: '今天,也要加油！',
    voice: 'assets/voice2.mp3'
  },
  {
    text: '想吃青枝月桂沙拉',
    voice: 'assets/voice1.mp3'
  }
]

let lastSpeechIndex = -1

// 状态：set（用户在操作电脑）/ idle（停下休息）/ walk（走动）
// 按你的修改：启动时直接进入 idle
let mode = 'idle'

let win = null
let pointerDown = false

// 拖拽
let dragTimer = null
let dragOffset = null
let dragOrigin = null
let dragged = false

// 状态机定时器
let walkTimer = null
let pauseTimer = null
let activityTimer = null

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sendState() {
  if (!win || win.isDestroyed()) {
    return
  }

  if (win.webContents.isDestroyed()) {
    return
  }

  win.webContents.send('pet-state', mode)
}

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    useContentSize: true,
    title: '桌面宠物',

    // 核心窗口配置
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,

    // 固定大小，避免用户拖拽边缘改变尺寸
    resizable: false,
    maximizable: false,
    fullscreenable: false,

    // 透明窗口建议关闭阴影，避免 Windows 上出现黑边
    hasShadow: false,
    show: false,

    webPreferences: {
      // 继续使用三文件结构，不额外创建 preload.js
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,

      // 允许点击时直接播放本地语音
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  win.center()

  win.webContents.on('did-finish-load', () => {
    sendState()
  })

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) {
      win.show()
    }
  })

  win.on('closed', () => {
    stopDragging()
    stopWalking()
    clearPauseTimer()

    win = null
  })
}

/* -------------------------------------------------------------------------- */
/* 状态机                                                                      */
/* -------------------------------------------------------------------------- */

function stopWalking() {
  if (walkTimer !== null) {
    clearTimeout(walkTimer)
    walkTimer = null
  }
}

function clearPauseTimer() {
  if (pauseTimer !== null) {
    clearTimeout(pauseTimer)
    pauseTimer = null
  }
}

// 回到“用户正在使用电脑”的常态
function wakeUp() {
  stopWalking()
  clearPauseTimer()

  mode = 'set'
  sendState()
}

function startWalking() {
  if (!win || win.isDestroyed()) {
    return
  }

  clearPauseTimer()
  stopWalking()

  mode = 'walk'
  sendState()

  // 窗口位置保持固定，只是播放 walk.gif；到时间后回到 idle
  walkTimer = setTimeout(() => {
    walkTimer = null

    if (mode === 'walk') {
      enterIdlePause()
    }
  }, randomBetween(WALK_DURATION_MIN, WALK_DURATION_MAX))
}

function scheduleIdlePause() {
  clearPauseTimer()

  pauseTimer = setTimeout(() => {
    pauseTimer = null

    if (!win || win.isDestroyed() || mode !== 'idle' || pointerDown) {
      return
    }

    // 定时器触发前用户刚好有操作，但轮询还没跑到：先唤醒
    if (powerMonitor.getSystemIdleTime() === 0) {
      wakeUp()
      return
    }

    startWalking()
  }, randomBetween(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX))
}

function enterIdlePause() {
  if (!win || win.isDestroyed()) {
    return
  }

  stopWalking()
  clearPauseTimer()

  mode = 'idle'
  sendState()
  scheduleIdlePause()
}

function pickSpeech() {
  if (SPEECHES.length === 1) {
    return SPEECHES[0]
  }

  let index = Math.floor(Math.random() * SPEECHES.length)

  // 避免连续两次说同一句
  while (index === lastSpeechIndex) {
    index = Math.floor(Math.random() * SPEECHES.length)
  }

  lastSpeechIndex = index
  return SPEECHES[index]
}

function saySomething() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return
  }

  win.webContents.send('pet-speak', pickSpeech())
}

function handlePetClick() {
  if (!win || win.isDestroyed()) {
    return
  }

  // 如果当前不是 set，先唤醒到 set，再随机说话
  if (mode !== 'set') {
    wakeUp()
  }

  saySomething()
}

// 系统级键鼠闲置检测：鼠标或键盘一有动作，系统闲置时间会归零
function checkSystemActivity() {
  if (!win || win.isDestroyed() || pointerDown) {
    return
  }

  const idleSeconds = powerMonitor.getSystemIdleTime()

  if (mode === 'set') {
    if (idleSeconds >= IDLE_THRESHOLD_SECONDS) {
      startWalking()
    }
    return
  }

  if (mode === 'idle') {
    // idle 状态下有真实键鼠操作：立刻回到 set
    if (idleSeconds === 0) {
      wakeUp()
      return
    }

    // 启动时直接处于 idle，且没有 pauseTimer。
    // 如果用户一直没操作，超过闲置阈值后再进入 walk。
    if (pauseTimer === null && idleSeconds >= IDLE_THRESHOLD_SECONDS) {
      startWalking()
    }
    return
  }

  // walk 状态下有真实键鼠操作：停止走动，回到 set
  if (mode === 'walk' && idleSeconds === 0) {
    wakeUp()
  }
}

function startActivityWatcher() {
  if (activityTimer !== null) {
    clearInterval(activityTimer)
  }

  activityTimer = setInterval(checkSystemActivity, ACTIVITY_POLL_MS)
}

/* -------------------------------------------------------------------------- */
/* 拖拽与点击                                                                  */
/* -------------------------------------------------------------------------- */

function startDragging() {
  if (!win || win.isDestroyed() || dragTimer) {
    return
  }

  // 记录鼠标相对窗口左上角的偏移
  const cursor = screen.getCursorScreenPoint()
  const [windowX, windowY] = win.getPosition()

  dragOffset = {
    x: cursor.x - windowX,
    y: cursor.y - windowY
  }

  dragOrigin = {
    x: cursor.x,
    y: cursor.y
  }

  dragged = false

  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset || !dragOrigin) {
      return
    }

    const point = screen.getCursorScreenPoint()

    // 位移太小，不移动窗口，保证“点击”可以被识别
    if (!dragged) {
      const distance = Math.hypot(
        point.x - dragOrigin.x,
        point.y - dragOrigin.y
      )

      if (distance <= CLICK_TOLERANCE) {
        return
      }

      dragged = true

      // 真正开始拖动，视为用户活动：停止走路，切回 set
      wakeUp()
    }

    // 用 setBounds 锁定宽高，避免 Windows 下窗口在拖动时偶发变大
    win.setBounds({
      x: point.x - dragOffset.x,
      y: point.y - dragOffset.y,
      width: WINDOW_SIZE,
      height: WINDOW_SIZE
    })
  }, DRAG_INTERVAL)
}

function stopDragging() {
  if (!dragTimer) {
    return null
  }

  clearInterval(dragTimer)
  dragTimer = null

  const wasDragged = dragged

  dragOffset = null
  dragOrigin = null
  dragged = false

  return wasDragged
}

// 按下鼠标：开始拖拽，同时暂停行走/待机计时
ipcMain.on('pet-drag-start', () => {
  pointerDown = true

  if (mode === 'walk') {
    stopWalking()
  }

  if (mode === 'idle') {
    clearPauseTimer()
  }

  startDragging()
})

// 松开鼠标：结束拖拽；如果几乎没有位移，就当作点击
ipcMain.on('pet-drag-end', (event, options = {}) => {
  const wasDragged = stopDragging()
  const cancelled = options && options.cancelled === true

  pointerDown = false

  if (cancelled) {
    // 失焦等异常结束：如果正在走动/待机，直接唤醒，避免状态卡住
    if (mode === 'walk' || mode === 'idle') {
      wakeUp()
    }
    return
  }

  if (wasDragged === false) {
    console.log("点击了桌宠")
    handlePetClick()
  }
})

// 右键桌宠：弹出原生菜单，提供退出入口
ipcMain.on('pet-context-menu', (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender)

  if (!targetWindow || targetWindow.isDestroyed()) {
    return
  }

  const menu = Menu.buildFromTemplate([
    {
      label: '退出桌宠',
      click: () => {
        app.quit()
      }
    }
  ])

  menu.popup({
    window: targetWindow
  })
})

app.whenReady().then(() => {
  createWindow()
  startActivityWatcher()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  stopDragging()
  stopWalking()
  clearPauseTimer()

  if (activityTimer !== null) {
    clearInterval(activityTimer)
    activityTimer = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
