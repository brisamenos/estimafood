/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  ESTIMAFOOD PRINT — Electron Main Process                   ║
 * ║  Impressão 100% silenciosa para impressoras térmicas    ║
 * ╚══════════════════════════════════════════════════════════╝
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

// ── Config persistente ──────────────────────────────────────
const store = new Store({
  defaults: {
    serverUrl: 'https://estimafood.evocrm.sbs/gestor.html',
    printer: '',
    paperWidth: 80,
    fontSize: 12,
    nome: 'ESTIMA FOOD',
    sub: '',
    rodape: 'Obrigado pela preferência!',
    autoStart: true,
    minimizeToTray: true,
    printCopies: 1,
    printMethod: 'electron', // 'electron' | 'escpos-usb' | 'escpos-network'
    networkPrinterIp: '',
    networkPrinterPort: 9100,
    windowBounds: { width: 1280, height: 800 }
  }
});

// ── Variáveis globais ───────────────────────────────────────
let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Helpers ─────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development';
const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
const iconPng = path.join(__dirname, '..', 'assets', 'icon.png');
const getIcon = () => {
  try {
    return process.platform === 'win32' ? iconPath : iconPng;
  } catch { return iconPng; }
};

function log(...args) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${ts}]`, ...args);
}

// ── Janela principal ────────────────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    minWidth: 900,
    minHeight: 600,
    icon: getIcon(),
    title: 'EstimaFood Print',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
    show: false,
  });

  // Remove menu bar
  mainWindow.setMenuBarVisibility(false);

  // Carrega URL do servidor ou tela de setup
  const serverUrl = store.get('serverUrl');
  if (serverUrl) {
    log('🌐 Carregando:', serverUrl);
    mainWindow.loadURL(serverUrl).catch(err => {
      log('❌ Erro ao carregar URL:', err.message);
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  // Save window bounds
  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('windowBounds', { width: w, height: h });
  });

  // Minimizar para tray em vez de fechar
  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Links externos abrem no navegador
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject CSS para esconder elementos web desnecessários no desktop
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      .pwa-install-banner, .update-toast { display: none !important; }
    `).catch(() => {});
  });
}

// ── System Tray ─────────────────────────────────────────────
function createTray() {
  try {
    const img = nativeImage.createFromPath(getIcon());
    tray = new Tray(img.resize({ width: 16, height: 16 }));
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📋 Abrir EstimaFood',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createWindow();
      }
    },
    { type: 'separator' },
    {
      label: '🖨️ Impressora: ' + (store.get('printer') || 'Padrão do sistema'),
      enabled: false
    },
    {
      label: '📄 Papel: ' + store.get('paperWidth') + 'mm',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '⚙️ Configurações',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.executeJavaScript(
            "typeof nav==='function'&&nav('impressao')"
          ).catch(() => {});
        }
      }
    },
    {
      label: '🔄 Recarregar',
      click: () => {
        if (mainWindow) mainWindow.reload();
      }
    },
    {
      label: '🔧 DevTools',
      visible: isDev,
      click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); }
    },
    { type: 'separator' },
    {
      label: '❌ Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('EstimaFood Print — Impressão Automática');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── Impressão silenciosa via Electron ───────────────────────
function getSysPrinters() {
  if (!mainWindow) return [];
  return mainWindow.webContents.getPrintersAsync();
}

async function printSilentElectron(html, opts = {}) {
  const printer = opts.printer || store.get('printer') || '';
  const paperWidth = opts.paperWidth || store.get('paperWidth') || 80;
  const copies = opts.copies || store.get('printCopies') || 1;
  const widthMm = paperWidth === 58 ? 58 : 80;

  const cleanHtml = html.includes('<html') ? html.replace(/.*<body[^>]*>/is,'').replace(/<\/body>.*/is,'') : html;

  // PASSO 1: Limpa o HTML — remove cores inline do tema escuro
  let safeHtml = cleanHtml
    .replace(/color\s*:\s*[^;"']+/gi, 'color:#000')
    .replace(/background\s*:\s*[^;"']+/gi, 'background:#fff')
    .replace(/background-color\s*:\s*[^;"']+/gi, 'background-color:#fff')
    .replace(/var\(--[^)]+\)/gi, '#000')
    .replace(/style="[^"]*"/gi, (match) => {
      // Mantém estilos de layout mas força cores
      return match
        .replace(/color\s*:\s*[^;"]+/gi, 'color:#000')
        .replace(/background\s*:\s*[^;"]+/gi, 'background:#fff');
    });

  // CSS agressivo que sobrescreve TUDO
  const resetCSS = `
    @page { size: WIDTHPLACEHOLDER HEIGHTPLACEHOLDER; margin: 0; }
    *, *::before, *::after { color: #000 !important; background: #fff !important; background-color: #fff !important; -webkit-print-color-adjust: exact !important; }
    body { font-family: 'Courier New', monospace; font-size: 12px; width: WIDTHPLACEHOLDER; margin: 0; padding: 2mm; }
    hr, .pt-hr { border: none !important; border-top: 1px dashed #000 !important; margin: 4px 0; background: transparent !important; }
    .pt-center { text-align: center; }
    .pt-large { font-size: 15px; font-weight: bold; }
    .print-ticket { padding: 0; width: 100%; }
  `;

  // Renderiza pra medir a altura
  const measureHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${resetCSS.replace(/WIDTHPLACEHOLDER/g, widthMm+'mm').replace(/HEIGHTPLACEHOLDER/g, 'auto')}</style>
</head><body>${safeHtml}</body></html>`;

  const measureFile = path.join(os.tmpdir(), 'ef-measure-' + Date.now() + '.html');
  fs.writeFileSync(measureFile, measureHtml, 'utf-8');

  const measureWin = new BrowserWindow({
    show: false, width: 800, height: 2000,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await measureWin.loadFile(measureFile);
  await new Promise(r => setTimeout(r, 600));

  const contentHeight = await measureWin.webContents.executeJavaScript('document.body.scrollHeight');
  const heightMm = Math.ceil(contentHeight * 0.265) + 15; // px to mm + margem
  measureWin.close();
  try { fs.unlinkSync(measureFile); } catch {}

  log('🖨️ Medido:', contentHeight + 'px →', heightMm + 'mm | largura:', widthMm + 'mm');

  // PASSO 2: Gera HTML com @page size exato
  const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${resetCSS.replace(/WIDTHPLACEHOLDER/g, widthMm+'mm').replace(/HEIGHTPLACEHOLDER/g, heightMm+'mm')}</style>
</head><body>${safeHtml}</body></html>`;

  const printFile = path.join(os.tmpdir(), 'ef-print-' + Date.now() + '.html');
  fs.writeFileSync(printFile, printHtml, 'utf-8');

  const printWin = new BrowserWindow({
    show: false, width: 800, height: 2000,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await printWin.loadFile(printFile);
    await new Promise(r => setTimeout(r, 600));

    // PASSO 3: Gera PDF — preferCSSPageSize faz o Chromium usar o @page do CSS
    const pdfBuffer = await printWin.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    printWin.close();

    const pdfFile = path.join(os.tmpdir(), 'ef-receipt-' + Date.now() + '.pdf');
    fs.writeFileSync(pdfFile, pdfBuffer);
    log('📄 PDF:', Math.round(pdfBuffer.length / 1024) + 'KB | tamanho:', widthMm + 'x' + heightMm + 'mm');

    // DEBUG: salva cópia na Área de Trabalho pra verificar visualmente
    try {
      const desktop = path.join(os.homedir(), 'Desktop');
      const debugPdf = path.join(desktop, 'EstimaFood-DEBUG.pdf');
      const debugHtml = path.join(desktop, 'EstimaFood-DEBUG.html');
      fs.writeFileSync(debugPdf, pdfBuffer);
      fs.writeFileSync(debugHtml, printHtml, 'utf-8');
      log('🔍 DEBUG: PDF e HTML salvos na Área de Trabalho');
    } catch (dbgErr) { log('⚠️ Debug save:', dbgErr.message); }

    // PASSO 4: Imprime o PDF silenciosamente
    try {
      const ptp = require('pdf-to-printer');
      const printOpts = {
        scale: 'noscale',  // NÃO redimensionar — envia no tamanho real
      };
      if (printer) printOpts.printer = printer;
      await ptp.print(pdfFile, printOpts);
      log('✅ Impresso via pdf-to-printer (noscale)' + (printer ? ' → ' + printer : ''));
    } catch (ptpErr) {
      log('⚠️ pdf-to-printer falhou:', ptpErr.message, '| Tentando SumatraPDF direto...');

      // Fallback: chama SumatraPDF empacotado pelo pdf-to-printer
      const { exec } = require('child_process');
      let sumatraPath;
      try {
        const ptpPath = require.resolve('pdf-to-printer');
        const ptpDir = path.dirname(ptpPath);
        // pdf-to-printer embute SumatraPDF em dist/
        const possible = [
          path.join(ptpDir, 'SumatraPDF.exe'),
          path.join(ptpDir, '..', 'SumatraPDF.exe'),
          path.join(ptpDir, 'SumatraPDF-3.4.6-64.exe'),
          path.join(ptpDir, '..', 'SumatraPDF-3.4.6-64.exe'),
        ];
        for (const p of possible) {
          if (fs.existsSync(p)) { sumatraPath = p; break; }
        }
      } catch {}

      // Tenta também em Program Files
      if (!sumatraPath) {
        const paths = [
          'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
          'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
          path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe'),
        ];
        for (const p of paths) {
          try { if (fs.existsSync(p)) { sumatraPath = p; break; } } catch {}
        }
      }

      if (sumatraPath) {
        const cmd = printer
          ? `"${sumatraPath}" -print-to "${printer}" -print-settings "noscale" -silent "${pdfFile}"`
          : `"${sumatraPath}" -print-to-default -print-settings "noscale" -silent "${pdfFile}"`;
        log('🖨️ SumatraPDF:', cmd);
        await new Promise((resolve) => {
          exec(cmd, { timeout: 15000 }, () => resolve());
        });
        log('✅ Impresso via SumatraPDF direto');
      } else {
        // Último fallback: PowerShell
        const cmd = printer
          ? `powershell -Command "Start-Process -FilePath '${pdfFile}' -Verb PrintTo '${printer}' -WindowStyle Hidden"`
          : `powershell -Command "Start-Process -FilePath '${pdfFile}' -Verb Print -WindowStyle Hidden"`;
        await new Promise((resolve) => {
          exec(cmd, { timeout: 15000 }, () => resolve());
        });
        log('✅ Impresso via PowerShell');
      }
    }

    // Limpa
    try { fs.unlinkSync(printFile); } catch {}
    setTimeout(() => { try { fs.unlinkSync(pdfFile); } catch {} }, 5000);
    return { ok: true };

  } catch (e) {
    try { printWin.close(); } catch {}
    try { fs.unlinkSync(printFile); } catch {}
    log('❌ Impressão falhou:', e.message);
    throw e;
  }
}

// ── Impressão ESC/POS via USB ───────────────────────────────
async function printEscPosUsb(order, cfg) {
  let escpos, escposUsb;
  try {
    escpos = require('escpos');
    escposUsb = require('escpos-usb');
    escpos.USB = escposUsb;
  } catch (e) {
    throw new Error('Módulo escpos não disponível: ' + e.message);
  }

  const paperWidth = cfg.paperWidth || store.get('paperWidth') || 80;
  const cols = paperWidth === 58 ? 32 : 48;

  return new Promise((resolve, reject) => {
    try {
      const device = new escpos.USB();
      const printer = new escpos.Printer(device, { encoding: 'cp860', width: cols });

      device.open((err) => {
        if (err) return reject(new Error('Erro ao abrir USB: ' + err.message));

        try {
          const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
          const items = Array.isArray(order.items) ? order.items : [];
          const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
          const taxa = parseFloat(order.taxa || 0);
          const total = subtotal + taxa;
          const now = new Date().toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
          });

          printer
            .align('ct')
            .style('b')
            .size(1, 1)
            .text(cfg.nome || store.get('nome') || 'ESTIMA FOOD')
            .style('normal')
            .size(0, 0);

          if (cfg.sub || store.get('sub')) {
            printer.text(cfg.sub || store.get('sub'));
          }

          printer
            .align('lt')
            .drawLine()
            .text('Pedido: #' + order.id)
            .text('Data: ' + now)
            .text('Cliente: ' + (order.client || '—'));

          if (order.addr) printer.text('Local: ' + order.addr);
          if (order.pag) printer.text('Pagto: ' + order.pag);

          printer.drawLine();

          items.forEach(i => {
            const name = (i.qty + 'x ' + i.name).toUpperCase().substring(0, cols - 14);
            const price = money((i.price || 0) * (i.qty || 1));
            printer.tableCustom([
              { text: name, align: 'LEFT', width: 0.65 },
              { text: price, align: 'RIGHT', width: 0.35 }
            ]);
            if (i.obs) printer.text('  * ' + i.obs);
          });

          printer.drawLine();

          if (taxa > 0) {
            printer.tableCustom([
              { text: 'Subtotal', align: 'LEFT', width: 0.65 },
              { text: money(subtotal), align: 'RIGHT', width: 0.35 }
            ]);
            printer.tableCustom([
              { text: 'Taxa entrega', align: 'LEFT', width: 0.65 },
              { text: money(taxa), align: 'RIGHT', width: 0.35 }
            ]);
          }

          printer
            .style('b')
            .tableCustom([
              { text: 'TOTAL', align: 'LEFT', width: 0.65 },
              { text: money(total), align: 'RIGHT', width: 0.35 }
            ])
            .style('normal')
            .drawLine()
            .align('ct')
            .text(cfg.rodape || store.get('rodape') || 'Obrigado!')
            .feed(3)
            .cut()
            .close(() => {
              log('✅ Impresso via ESC/POS USB');
              resolve({ ok: true });
            });

        } catch (e) {
          try { device.close(); } catch {}
          reject(e);
        }
      });
    } catch (e) {
      reject(new Error('Impressora USB não encontrada: ' + e.message));
    }
  });
}

// ── Impressão ESC/POS via Rede (TCP) ────────────────────────
async function printEscPosNetwork(order, cfg) {
  let escpos, escposNetwork;
  try {
    escpos = require('escpos');
    escposNetwork = require('escpos-network');
    escpos.Network = escposNetwork;
  } catch (e) {
    throw new Error('Módulo escpos-network não disponível: ' + e.message);
  }

  const ip = cfg.networkIp || store.get('networkPrinterIp') || '';
  const port = cfg.networkPort || store.get('networkPrinterPort') || 9100;
  if (!ip) throw new Error('IP da impressora de rede não configurado');

  const paperWidth = cfg.paperWidth || store.get('paperWidth') || 80;
  const cols = paperWidth === 58 ? 32 : 48;

  return new Promise((resolve, reject) => {
    const device = new escpos.Network(ip, port);
    const printer = new escpos.Printer(device, { encoding: 'cp860', width: cols });

    device.open((err) => {
      if (err) return reject(new Error('Erro de rede: ' + err.message));

      try {
        const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
        const items = Array.isArray(order.items) ? order.items : [];
        const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
        const taxa = parseFloat(order.taxa || 0);
        const total = subtotal + taxa;
        const now = new Date().toLocaleString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });

        printer
          .align('ct').style('b').size(1, 1)
          .text(cfg.nome || store.get('nome') || 'ESTIMA FOOD')
          .style('normal').size(0, 0);

        if (cfg.sub || store.get('sub')) printer.text(cfg.sub || store.get('sub'));

        printer.align('lt').drawLine()
          .text('Pedido: #' + order.id)
          .text('Data: ' + now)
          .text('Cliente: ' + (order.client || '—'));

        if (order.addr) printer.text('Local: ' + order.addr);
        if (order.pag) printer.text('Pagto: ' + order.pag);
        printer.drawLine();

        items.forEach(i => {
          const name = (i.qty + 'x ' + i.name).toUpperCase().substring(0, cols - 14);
          const price = money((i.price || 0) * (i.qty || 1));
          printer.tableCustom([
            { text: name, align: 'LEFT', width: 0.65 },
            { text: price, align: 'RIGHT', width: 0.35 }
          ]);
          if (i.obs) printer.text('  * ' + i.obs);
        });

        printer.drawLine();
        if (taxa > 0) {
          printer.tableCustom([
            { text: 'Subtotal', align: 'LEFT', width: 0.65 },
            { text: money(subtotal), align: 'RIGHT', width: 0.35 }
          ]);
          printer.tableCustom([
            { text: 'Taxa entrega', align: 'LEFT', width: 0.65 },
            { text: money(taxa), align: 'RIGHT', width: 0.35 }
          ]);
        }

        printer
          .style('b')
          .tableCustom([
            { text: 'TOTAL', align: 'LEFT', width: 0.65 },
            { text: money(total), align: 'RIGHT', width: 0.35 }
          ])
          .style('normal').drawLine()
          .align('ct')
          .text(cfg.rodape || store.get('rodape') || 'Obrigado!')
          .feed(3).cut()
          .close(() => {
            log('✅ Impresso via ESC/POS Rede');
            resolve({ ok: true });
          });

      } catch (e) {
        try { device.close(); } catch {}
        reject(e);
      }
    });
  });
}

// ── Roteador de impressão ───────────────────────────────────
async function printOrder(order) {
  const cfg = {
    nome: store.get('nome') || 'ESTIMA FOOD',
    sub: store.get('sub') || '',
    rodape: store.get('rodape') || 'Obrigado pela preferência!',
    paperWidth: store.get('paperWidth') || 80,
    fontSize: store.get('fontSize') || 12,
    printer: store.get('printer') || '',
  };

  log('🖨️ Imprimindo pedido #' + order.id, '| impressora:', cfg.printer || 'padrão', '| papel:', cfg.paperWidth + 'mm');

  // ── MÉTODO PRINCIPAL: ESC/POS RAW (funciona com qualquer térmica) ──
  try {
    return await printRawEscPos(order, cfg);
  } catch (e) {
    log('⚠️ ESC/POS raw falhou:', e.message);
  }

  // ── FALLBACK: PDF via pdf-to-printer ──
  try {
    const html = buildTicketHtml(order, cfg);
    return await printSilentElectron(html, cfg);
  } catch (e) {
    log('❌ Todos os métodos falharam:', e.message);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// ESC/POS RAW — Envia bytes diretos à impressora térmica
// Funciona com QUALQUER térmica 58mm/80mm no Windows
// ══════════════════════════════════════════════════════════════

function buildEscPosBytes(order, cfg) {
  const buf = [];
  const paperWidth = cfg.paperWidth || 80;
  const cols = paperWidth === 58 ? 32 : 48;
  const sep = '-'.repeat(cols);

  // Mapeamento UTF-16 → CP860 (Português — codepage usada por impressoras térmicas)
  const CP860 = {
    0xC7:0x80, 0xFC:0x81, 0xE9:0x82, 0xE2:0x83, 0xE3:0x84, 0xE0:0x85, 0xC1:0x86,
    0xE7:0x87, 0xEA:0x88, 0xCA:0x89, 0xE8:0x8A, 0xCD:0x8B, 0xD4:0x8C, 0xEC:0x8D,
    0xC3:0x8E, 0xC2:0x8F, 0xC9:0x90, 0xC0:0x91, 0xC8:0x92, 0xF4:0x93, 0xF5:0x94,
    0xF2:0x95, 0xDA:0x96, 0xF9:0x97, 0xCC:0x98, 0xD5:0x99, 0xDC:0x9A, 0xA2:0x9B,
    0xA3:0x9C, 0xD9:0x9D, 0x20A7:0x9E, 0x192:0x9F, 0xE1:0xA0, 0xED:0xA1, 0xF3:0xA2,
    0xFA:0xA3, 0xF1:0xA4, 0xD1:0xA5, 0xAA:0xA6, 0xBA:0xA7, 0xBF:0xA8, 0x2310:0xA9,
    0xAC:0xAA, 0xBD:0xAB, 0xBC:0xAC, 0xA1:0xAD, 0xAB:0xAE, 0xBB:0xAF,
  };

  const write = (str) => {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 128) {
        buf.push(c);
      } else if (CP860[c] !== undefined) {
        buf.push(CP860[c]);
      } else if (c > 255) {
        buf.push(63); // '?' para caracteres sem mapeamento
      } else {
        buf.push(c);
      }
    }
  };
  const raw = (...bytes) => bytes.forEach(b => buf.push(b));
  const line = (str) => { write(str); raw(0x0A); };

  const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
  const pad2col = (left, right) => {
    const space = cols - left.length - right.length;
    return left + (space > 0 ? ' '.repeat(space) : ' ') + right;
  };

  // ESC @ — Reset
  raw(0x1B, 0x40);

  // Codepage 860 (Português)
  raw(0x1B, 0x74, 0x03);

  // ── Cabeçalho ──
  raw(0x1B, 0x61, 0x01); // Centralizar
  raw(0x1D, 0x21, 0x11); // Fonte dupla largura+altura
  line(cfg.nome);
  raw(0x1D, 0x21, 0x00); // Fonte normal
  if (cfg.sub) line(cfg.sub);
  raw(0x1B, 0x61, 0x00); // Alinhar esquerda
  line(sep);

  // ── Dados do pedido ──
  const now = new Date().toLocaleString('pt-BR', {
    day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
  });
  line('Pedido: #' + order.id);
  line('Data: ' + now);
  line('Cliente: ' + (order.client || '-'));
  if (order.addr) line('Local: ' + order.addr);
  if (order.mesa_num) line('Mesa: ' + order.mesa_num);
  if (order.pag) line('Pagto: ' + order.pag);
  line(sep);

  // ── Itens ──
  const items = Array.isArray(order.items) ? order.items : [];
  const maxName = cols - 14;
  items.forEach(i => {
    const name = (i.qty + 'x ' + i.name).toUpperCase().substring(0, maxName);
    const price = money((i.price || 0) * (i.qty || 1));
    line(pad2col(name, price));
    if (i.obs) line('  * ' + i.obs);
  });
  line(sep);

  // ── Totais ──
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
  const taxa = parseFloat(order.taxa || 0);
  const total = subtotal + taxa;

  if (taxa > 0) {
    line(pad2col('Subtotal', money(subtotal)));
    line(pad2col('Taxa entrega', money(taxa)));
  }
  raw(0x1B, 0x45, 0x01); // Negrito ON
  line(pad2col('TOTAL', money(total)));
  raw(0x1B, 0x45, 0x00); // Negrito OFF
  line(sep);

  // ── Rodapé ──
  raw(0x1B, 0x61, 0x01); // Centralizar
  line(cfg.rodape);
  raw(0x1B, 0x61, 0x00); // Esquerda

  // Avança papel e corta
  raw(0x0A, 0x0A, 0x0A, 0x0A);
  raw(0x1D, 0x56, 0x42, 0x03); // GS V — corte parcial

  return Buffer.from(buf);
}

async function printRawEscPos(order, cfg) {
  const printerName = cfg.printer || '';
  const data = buildEscPosBytes(order, cfg);

  log('🖨️ ESC/POS raw:', data.length, 'bytes | impressora:', printerName || 'padrão');

  // Salva bytes num arquivo temporário
  const tmpFile = path.join(os.tmpdir(), 'ef-raw-' + Date.now() + '.bin');
  fs.writeFileSync(tmpFile, data);

  // DEBUG: salva cópia
  try {
    const desktop = path.join(os.homedir(), 'Desktop');
    fs.writeFileSync(path.join(desktop, 'EstimaFood-DEBUG.bin'), data);
  } catch {}

  const { exec } = require('child_process');

  if (process.platform === 'win32') {
    // Descobre o nome da impressora
    let targetPrinter = printerName;

    if (!targetPrinter) {
      // Pega impressora padrão do Windows
      try {
        targetPrinter = await new Promise((resolve, reject) => {
          exec('powershell -Command "(Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE Default=TRUE\\").Name"',
            (err, stdout) => {
              if (err) reject(err);
              else resolve(stdout.trim());
            });
        });
        log('🖨️ Impressora padrão:', targetPrinter);
      } catch (e) {
        log('⚠️ Não conseguiu pegar impressora padrão:', e.message);
        throw new Error('Nenhuma impressora configurada');
      }
    }

    // Método 1: Envia RAW via PowerShell (mais confiável)
    const ps1 = `
      $printerName = '${targetPrinter.replace(/'/g, "''")}'
      $data = [System.IO.File]::ReadAllBytes('${tmpFile.replace(/\\/g, '\\\\')}')
      $printer = New-Object System.Drawing.Printing.PrintDocument
      $printer.PrinterSettings.PrinterName = $printerName
      
      # Abre porta RAW
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class RawPrint {
        [StructLayout(LayoutKind.Sequential)] public struct DOCINFOA { public string pDocName; public string pOutputFile; public string pDatatype; }
        [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr d);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h, int l, ref DOCINFOA di);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int cb, out int written);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
        
        public static bool Send(string printer, byte[] data) {
          IntPtr h;
          if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;
          var di = new DOCINFOA { pDocName = "EstimaFood", pDatatype = "RAW" };
          StartDocPrinter(h, 1, ref di);
          StartPagePrinter(h);
          int written;
          WritePrinter(h, data, data.Length, out written);
          EndPagePrinter(h);
          EndDocPrinter(h);
          ClosePrinter(h);
          return written == data.Length;
        }
      }
"@
      
      $ok = [RawPrint]::Send($printerName, $data)
      if ($ok) { Write-Output "OK" } else { Write-Error "FAIL" }
    `;

    const ps1File = path.join(os.tmpdir(), 'ef-print-' + Date.now() + '.ps1');
    fs.writeFileSync(ps1File, ps1, 'utf-8');

    return new Promise((resolve, reject) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${ps1File}"`, { timeout: 15000 }, (err, stdout, stderr) => {
        // Limpa
        try { fs.unlinkSync(tmpFile); } catch {}
        try { fs.unlinkSync(ps1File); } catch {}

        if (stdout && stdout.includes('OK')) {
          log('✅ Impresso via RAW direto na', targetPrinter);
          resolve({ ok: true });
        } else if (err || stderr) {
          log('❌ RAW falhou:', stderr || err?.message);
          reject(new Error(stderr || err?.message || 'Falha RAW'));
        } else {
          log('✅ Enviado à impressora (sem confirmação)');
          resolve({ ok: true });
        }
      });
    });

  } else {
    // Linux/Mac: lp -o raw
    const cmd = printerName
      ? `lp -d "${printerName}" -o raw "${tmpFile}"`
      : `lp -o raw "${tmpFile}"`;
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 15000 }, (err) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (err) reject(err);
        else resolve({ ok: true });
      });
    });
  }
}

// ── Gera HTML do ticket (espelho do frontend) ───────────────
function buildTicketHtml(order, cfg) {
  const items = Array.isArray(order.items) ? order.items : [];
  const now = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
  const fs = cfg.fontSize || 12;

  const itemLines = items.map(i => {
    const name = (i.qty + 'x ' + i.name).toUpperCase();
    const price = money((i.price || 0) * (i.qty || 1));
    return `<div style="display:flex;justify-content:space-between"><span>${name}</span><span style="white-space:nowrap;margin-left:8px">${price}</span></div>`;
  }).join('');

  const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
  const taxa = parseFloat(order.taxa || 0);
  const total = subtotal + taxa;

  let obsLines = '';
  items.forEach(i => {
    if (i.obs) obsLines += `<div style="font-size:${fs - 1}px;color:#333">  ↳ ${i.obs}</div>`;
  });

  return `<div class="print-ticket" style="font-size:${fs}px">
    <div class="pt-center pt-large">${cfg.nome || 'ESTIMA FOOD'}</div>
    ${cfg.sub ? `<div class="pt-center" style="font-size:11px">${cfg.sub}</div>` : ''}
    <hr class="pt-hr">
    <div>Pedido: <b>#${order.id}</b></div>
    <div>Data: ${now}</div>
    <div>Cliente: ${order.client || '—'}</div>
    ${order.addr ? `<div>Local: ${order.addr}</div>` : ''}
    ${order.mesa_num ? `<div>Mesa: ${order.mesa_num}</div>` : ''}
    <hr class="pt-hr">
    ${itemLines}
    ${obsLines}
    <hr class="pt-hr">
    ${taxa > 0 ? `<div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${money(subtotal)}</span></div><div style="display:flex;justify-content:space-between"><span>Taxa entrega</span><span>${money(taxa)}</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;font-weight:bold"><span>TOTAL</span><span>${money(total)}</span></div>
    ${order.pag ? `<div>Pagamento: ${order.pag}</div>` : ''}
    <hr class="pt-hr">
    <div class="pt-center" style="font-size:11px">${cfg.rodape || 'Obrigado!'}</div>
  </div>`;
}

// ── IPC Handlers ────────────────────────────────────────────
function setupIPC() {

  // getPrintConfig → { printers, printer, paperWidth, ... }
  ipcMain.handle('print:getConfig', async () => {
    const printers = await getSysPrinters();
    return {
      printers: printers.map(p => p.name),
      printer: store.get('printer') || '',
      paperWidth: store.get('paperWidth'),
      fontSize: store.get('fontSize'),
      nome: store.get('nome'),
      sub: store.get('sub'),
      rodape: store.get('rodape'),
      printMethod: store.get('printMethod'),
      networkPrinterIp: store.get('networkPrinterIp'),
      networkPrinterPort: store.get('networkPrinterPort'),
      printCopies: store.get('printCopies'),
    };
  });

  // savePrintConfig
  ipcMain.handle('print:saveConfig', async (_e, cfg) => {
    if (cfg.printer !== undefined)     store.set('printer', cfg.printer);
    if (cfg.paperWidth !== undefined)  store.set('paperWidth', cfg.paperWidth);
    if (cfg.fontSize !== undefined)    store.set('fontSize', cfg.fontSize);
    if (cfg.nome !== undefined)        store.set('nome', cfg.nome);
    if (cfg.sub !== undefined)         store.set('sub', cfg.sub);
    if (cfg.rodape !== undefined)      store.set('rodape', cfg.rodape);
    if (cfg.printMethod !== undefined) store.set('printMethod', cfg.printMethod);
    if (cfg.networkPrinterIp !== undefined) store.set('networkPrinterIp', cfg.networkPrinterIp);
    if (cfg.networkPrinterPort !== undefined) store.set('networkPrinterPort', cfg.networkPrinterPort);
    if (cfg.printCopies !== undefined) store.set('printCopies', cfg.printCopies);
    // Atualiza tray
    if (tray) createTray();
    log('💾 Config salva:', JSON.stringify(cfg));
    return { ok: true };
  });

  // printOrder → imprime silenciosamente
  ipcMain.handle('print:order', async (_e, order) => {
    try {
      return await printOrder(order);
    } catch (e) {
      log('❌ Erro ao imprimir:', e.message);
      return { ok: false, error: e.message };
    }
  });

  // printHtml → imprime HTML bruto silenciosamente
  ipcMain.handle('print:html', async (_e, html, opts) => {
    try {
      return await printSilentElectron(html, opts || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Notificação nativa
  ipcMain.handle('app:notify', async (_e, title, body) => {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title,
        body,
        icon: getIcon(),
        silent: false,
      });
      notif.show();
    }
    return { ok: true };
  });

  // Setup inicial — salvar URL do servidor
  ipcMain.handle('app:setServerUrl', async (_e, url) => {
    store.set('serverUrl', url.replace(/\/$/, ''));
    log('🌐 URL salva:', url);
    if (mainWindow) {
      mainWindow.loadURL(store.get('serverUrl'));
    }
    return { ok: true };
  });

  ipcMain.handle('app:getServerUrl', async () => {
    return store.get('serverUrl') || '';
  });

  // Reiniciar app
  ipcMain.handle('app:restart', async () => {
    app.relaunch();
    app.exit(0);
  });

  // Versão
  ipcMain.handle('app:version', async () => {
    return app.getVersion();
  });

  // Abre devtools
  ipcMain.handle('app:devtools', async () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });
}

// ── Auto-updater ────────────────────────────────────────────
function setupUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      log('📦 Atualização disponível:', info.version);
      if (Notification.isSupported()) {
        new Notification({
          title: 'EstimaFood Print — Atualização',
          body: `Versão ${info.version} disponível. Baixando...`,
          icon: getIcon(),
        }).show();
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      log('✅ Atualização baixada:', info.version);
      if (Notification.isSupported()) {
        new Notification({
          title: 'EstimaFood Print — Pronta!',
          body: 'A atualização será instalada ao reiniciar.',
          icon: getIcon(),
        }).show();
      }
    });

    autoUpdater.on('error', (err) => {
      log('⚠️ Updater erro:', err.message);
    });

    // Verifica a cada 4 horas
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 4 * 60 * 60 * 1000);
  } catch (e) {
    log('⚠️ Auto-updater não disponível:', e.message);
  }
}

// ── Auto-start com Windows ──────────────────────────────────
function setupAutoStart() {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: store.get('autoStart'),
      openAsHidden: true,
      args: ['--hidden'],
    });
  } catch (e) {
    log('⚠️ AutoStart erro:', e.message);
  }
}

// ── App lifecycle ───────────────────────────────────────────
app.whenReady().then(() => {
  setupIPC();
  createWindow();
  createTray();
  setupAutoStart();

  // Auto-updater só em produção
  if (!isDev) setupUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  log('✅ EstimaFood Print iniciado | versão:', app.getVersion());
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store.get('minimizeToTray')) {
    app.quit();
  }
});

// Impede múltiplas instâncias
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
