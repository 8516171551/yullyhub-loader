const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    setIgnoreMouseEvents: (ignore, opts) => {
        ipcRenderer.send('set-ignore-mouse-events', ignore, opts);
    }
});

contextBridge.exposeInMainWorld('YULLY_HOST', process.env.YULLY_HOST || '127.0.0.1:3000');
