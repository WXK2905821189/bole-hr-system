// 伯乐招聘系统 · Electron 主进程
// 职责：内嵌启动 Node 后端(createApplication) → 打开窗口加载本地前端 → 初始化自动更新
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApplication } from '../framework/server.js';
import { initAutoUpdater, sfMenuCheck } from './updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 单实例：避免用户重复打开导致两个后端实例争用同一数据目录
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 后端实例与端口
let hrApp = null;
let serverPort = 4700;
let mainWindow = null;

// 内网数据目录：优先内置目录（开发模式），打包后落到用户数据目录，避免 Program Files 写入权限问题
function dataRoot() {
  if (process.env.ELECTRON_DEV) return join(__dirname, '..');
  return app.getPath('userData'); // %APPDATA%/伯乐招聘系统
}

function resolvePythonOverride() {
  // 打包后允许通过环境变量 HR_PYTHON 覆盖；否则走 server.js 自带探测链
  return process.env.HR_PYTHON || undefined;
}

async function startBackend() {
  const root = dataRoot();
  const storeDir = join(root, 'infra', 'store');
  const filesDir = join(root, 'infra', 'files');
  hrApp = await createApplication({
    storeDir,
    filesDir,
    python: resolvePythonOverride(),
    llm: {
      baseURL: process.env.HR_LLM_BASE,
      apiKey: process.env.HR_LLM_KEY,
      model: process.env.HR_LLM_MODEL,
    },
    auth: { token: process.env.HR_AUTH_TOKEN || undefined, actor: process.env.HR_AUTH_ACTOR || undefined },
  });
  // 固定端口：单实例锁已保证唯一进程；若被占用则回退随机端口
  serverPort = Number(process.env.HR_PORT) || 4700;
  await hrApp.start(serverPort);
  return serverPort;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: '伯乐招聘系统',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const menu = Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '系统',
      submenu: [
        { label: '检查更新…', click: () => sfMenuCheck() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  buildMenu();
  initAutoUpdater();
  try {
    await startBackend();
  } catch (e) {
    dialog.showErrorBox('伯乐招聘系统启动失败', String(e?.message || e));
    app.quit();
    return;
  }
  createMainWindow();

  // IPC：让前端拿到当前版本与内嵌环境信息（更新按钮展示用）
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electronMode: true,
  }));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// 单实例被再次启动：聚焦已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // 非 macOS：关闭窗口即退出（连同后端进程）
  if (process.platform !== 'darwin') app.quit();
});

// 外部链接一律交给系统浏览器，避免在应用内打开
ipcMain.handle('app:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});