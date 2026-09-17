const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    setIgnoreMouseEvents: (ignore, opts) => {
        ipcRenderer.send('set-ignore-mouse-events', ignore, opts);
    },

    // Global keybind bridge for script steps.
    registerKeybind:      (acc)      => ipcRenderer.send('register-keybind', acc),
    unregisterKeybind:    (acc)      => ipcRenderer.send('unregister-keybind', acc),
    unregisterAllKeybinds: ()        => ipcRenderer.send('unregister-all-keybinds'),
    onKeybind:            (cb)       => {
        const handler = (_e, acc) => cb(acc);
        ipcRenderer.on('global-keybind', handler);
        return () => ipcRenderer.removeListener('global-keybind', handler);
    },
});

contextBridge.exposeInMainWorld('YULLY_HOST', process.env.YULLY_HOST || '127.0.0.1:3000');
