const { app, BrowserWindow, screen, ipcMain, globalShortcut } = require('electron');
const path = require('path');

let win;

function createWindow() {
    const primary = screen.getPrimaryDisplay();
    const workArea = primary.workArea; // { x, y, width, height } — excludes taskbar

    // Bottom-center overlay. Same tall canvas as before so the success
    // state still fits — Electron just parks the window flush against
    // the bottom of the usable screen area (above the taskbar).
    const winWidth = 780;
    const winHeight = 340;

    win = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: workArea.x + Math.round((workArea.width - winWidth) / 2),
        y: workArea.y + workArea.height - winHeight,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        focusable: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    // Fully click-through by default — pill lights up when the mouse actually
    // enters the pill's pixel bounds (renderer.js toggles this).
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile('index.html');

    ipcMain.on('set-ignore-mouse-events', (_event, ignore, opts) => {
        if (win && !win.isDestroyed()) {
            win.setIgnoreMouseEvents(ignore, opts || {});
        }
    });

    // ---- Global keybind registration for script steps ----
    // Renderer requests a keybind for a step; we register with the OS via
    // Electron's globalShortcut and forward every trigger back as an IPC
    // event. Renderer is responsible for unregistering when the step ends.
    const activeShortcuts = new Set();
    ipcMain.on('register-keybind', (_evt, accelerator) => {
        try {
            if (!accelerator || activeShortcuts.has(accelerator)) return;
            const ok = globalShortcut.register(accelerator, () => {
                if (win && !win.isDestroyed()) {
                    win.webContents.send('global-keybind', accelerator);
                }
            });
            if (ok) activeShortcuts.add(accelerator);
        } catch {}
    });
    ipcMain.on('unregister-keybind', (_evt, accelerator) => {
        try {
            if (!accelerator) return;
            globalShortcut.unregister(accelerator);
            activeShortcuts.delete(accelerator);
        } catch {}
    });
    ipcMain.on('unregister-all-keybinds', () => {
        try {
            globalShortcut.unregisterAll();
            activeShortcuts.clear();
        } catch {}
    });

    win.on('closed', () => {
        try { globalShortcut.unregisterAll(); } catch {}
        win = null;
    });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
