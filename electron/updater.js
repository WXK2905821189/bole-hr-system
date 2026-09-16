// 伯乐招聘系统 · 自动更新
// 通过 electron-updater 对接 GitHub Releases；发布时生成 latest.yml，应用据此检测/下载/安装新版本。
import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import updater from 'electron-updater';
const { autoUpdater } = updater;

autoUpdater.autoDownload = false;      // 由用户/前端显式触发下载，避免后台悄悄下载大包
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.autoRunAppAfterInstall = true;

function send(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('update:event', payload);
  }
}

function emit(status, detail = {}) {
  send({ status, ...detail });
}

function registerUpdater() {
  autoUpdater.on('checking-for-update', () => emit('checking'));
  autoUpdater.on('update-available', (info) => emit('available', { version: info.version, notes: info.releaseNotes }));
  autoUpdater.on('update-not-available', () => emit('not-available', { reason: '已经是最新版本' }));
  autoUpdater.on('error', (err) => emit('error', { message: String(err?.message || err) }));
  autoUpdater.on('download-progress', (p) =>
    emit('download-progress', {
      progress: Math.round(p.percent),
      transferred: Math.round(p.transferred / 1048576),
      total: Math.round(p.total / 1048576),
      speed: Math.round(p.bytesPerSecond / 1024),
    }));
  autoUpdater.on('update-downloaded', (info) => emit('downloaded', { version: info.version }));

  ipcMain.on('update:check', () => {
    emit('checking');
    autoUpdater.checkForUpdates().catch((e) => emit('error', { message: String(e?.message || e) }));
  });

  ipcMain.on('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      emit('error', { message: String(e?.message || e) });
    }
  });

  ipcMain.on('update:install', async () => {
    try {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    } catch (e) {
      dialog.showErrorBox('安装更新失败', String(e?.message || e));
    }
  });
}

// 启动后自动做一次静默检查（不打扰，仅在有新版本时提示），用户在前端点按钮可再次检查
export function initAutoUpdater() {
  registerUpdater();
  app.whenReady().then(() => {
    // 开发模式（未打包）没有 app-update.yml，跳过自动检查，避免 updater 因缺失配置报错
    if (process.env.ELECTRON_DEV && !process.env.HR_ALLOW_UPDATE_DEV) {
      emit('not-available', { reason: '开发模式，已跳过更新检查' });
      return;
    }
    // 延迟几秒，避免与应用首启叠加卡顿
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => { /* 静默：检查失败不打扰，用户可手动再点 */ });
    }, 8000);
  });
}

// 菜单「检查更新」入口：与前端按钮走同一检查流程
export function sfMenuCheck() {
  if (process.env.ELECTRON_DEV && !process.env.HR_ALLOW_UPDATE_DEV) {
    emit('not-available', { reason: '开发模式，已跳过更新检查' });
    return;
  }
  emit('checking');
  autoUpdater.checkForUpdates().catch((e) => emit('error', { message: String(e?.message || e) }));
}