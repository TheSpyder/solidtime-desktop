import { join } from 'path'
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, ipcMain } from 'electron'
import { isE2ETesting } from './env'

export function initializeMiniWindow(icon: string) {
    const miniWindow = new BrowserWindow({
        width: 420,
        height: 32,
        show: false,
        autoHideMenuBar: true,
        frame: false,
        resizable: false,
        transparent: true,
        hasShadow: false,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: {
            preload: join(__dirname, '../preload/mini.mjs'),
            sandbox: false,
        },
    })
    miniWindow.setAutoHideMenuBar(true)
    miniWindow.on('ready-to-show', () => {
        miniWindow.setAlwaysOnTop(true, 'floating')
        if (process.platform === 'win32') {
            miniWindow.setShape([{ x: 0, y: 0, width: 420, height: 32 }])
        }
    })

    return miniWindow
}

// Last state pushed by the main window, replayed when the mini window asks
// for it at startup (its webContents may not exist yet during early pushes)
let currentTimeEntryState: string | null = null
let lastTimeEntryState: string | null = null

export function registerMiniWindowListeners(miniWindow: BrowserWindow) {
    // The 'updateTrayState' message from the main window carries the
    // serialized current time entry; one message feeds the tray and the
    // mini window
    ipcMain.on('updateTrayState', (_event, serializedTimeEntry: string) => {
        currentTimeEntryState = serializedTimeEntry
        miniWindow.webContents.send('currentTimeEntryChanged', serializedTimeEntry)
    })
    ipcMain.on('updateLastTimeEntry', (_event, serializedTimeEntry: string) => {
        lastTimeEntryState = serializedTimeEntry
        miniWindow.webContents.send('lastTimeEntryChanged', serializedTimeEntry)
    })
    ipcMain.handle('getTimeEntryState', () => ({
        currentTimeEntry: currentTimeEntryState,
        lastTimeEntry: lastTimeEntryState,
    }))
    ipcMain.on('showMiniWindow', () => {
        if (!isE2ETesting()) {
            miniWindow.show()
            miniWindow.focus()
        }
    })
    ipcMain.on('hideMiniWindow', () => {
        miniWindow.hide()
    })
    let forcequit = false
    miniWindow.on('close', (event) => {
        if (process.platform === 'darwin') {
            if (forcequit === false) {
                event.preventDefault()
                miniWindow.hide()
            }
        } else {
            app.quit()
        }
    })
    app.on('before-quit', () => {
        forcequit = true
    })
    nativeAutoUpdater.on('before-quit-for-update', () => {
        forcequit = true
    })
}
