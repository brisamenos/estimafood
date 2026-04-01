/**
 * Preload — expõe window.ElectronPrint para o frontend web
 *
 * API compatível com o que o gestor.html já espera:
 *   window.ElectronPrint.getPrintConfig()     → { printers, printer }
 *   window.ElectronPrint.savePrintConfig(cfg) → { ok }
 *   window.ElectronPrint.printOrder(order)    → { ok }
 *   window.ElectronPrint.notify(title, body)  → void
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ElectronPrint', {

  // ── Impressão ─────────────────────────────────────────
  getPrintConfig: () => ipcRenderer.invoke('print:getConfig'),

  savePrintConfig: (cfg) => ipcRenderer.invoke('print:saveConfig', cfg),

  printOrder: (order) => ipcRenderer.invoke('print:order', order),

  printHtml: (html, opts) => ipcRenderer.invoke('print:html', html, opts),

  // ── Notificação nativa do OS ──────────────────────────
  notify: (title, body) => ipcRenderer.invoke('app:notify', title, body),

  // ── App ────────────────────────────────────────────────
  setServerUrl: (url) => ipcRenderer.invoke('app:setServerUrl', url),

  getServerUrl: () => ipcRenderer.invoke('app:getServerUrl'),

  restart: () => ipcRenderer.invoke('app:restart'),

  getVersion: () => ipcRenderer.invoke('app:version'),

  openDevTools: () => ipcRenderer.invoke('app:devtools'),

  // ── Identifica que estamos no Electron ─────────────────
  isElectron: true,
  platform: process.platform,
});

// Marca global para detecção rápida
contextBridge.exposeInMainWorld('__ELECTRON__', true);
