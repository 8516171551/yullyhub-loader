const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

let win;

function createWindow() {
    const primary = screen.getPrimaryDisplay();
    const { width: sw } = primary.workAreaSize;

    // Top-center overlay. Tall enough for the success state (biggest
    // panel, ~200px on-screen).
    const winWidth = 780;
    const winHeight = 340;

    win = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: Math.round((sw - winWidth) / 2),
        y: 0,
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

    win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
