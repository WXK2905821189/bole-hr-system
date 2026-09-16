// 伯乐招聘系统 · preload
// 安全模型：contextIsolation 开启，仅通过 contextBridge 暴露白名单 API 给渲染层。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('boleUpdater', {
  // 检查更新：由菜单或前端按钮触发；进度通过 onEvent 推送
  check: () => ipcRenderer.send('update:check'),
  // 下载更新
  download: () => ipcRenderer.send('update:download'),
  // 下载完成后安装并重启
  install: () => ipcRenderer.send('update:install'),
  // 订阅更新状态事件：checking / available / not-available / download-progress / downloaded / error
  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },
});

contextBridge.exposeInMainWorld('boleApp', {
  version: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
});