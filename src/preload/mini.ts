import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI)
        contextBridge.exposeInMainWorld('api', api)
        contextBridge.exposeInMainWorld('electronAPI', {
            startTimer: () => ipcRenderer.send('startTimer'),
            stopTimer: () => ipcRenderer.send('stopTimer'),
            showMainWindow: () => ipcRenderer.send('showMainWindow'),
            onCurrentTimeEntryChanged: (callback: (serialized: string) => void) =>
                ipcRenderer.on('currentTimeEntryChanged', (_event, value) => callback(value)),
            onLastTimeEntryChanged: (callback: (serialized: string) => void) =>
                ipcRenderer.on('lastTimeEntryChanged', (_event, value) => callback(value)),
            getTimeEntryState: () => ipcRenderer.invoke('getTimeEntryState'),
        })
    } catch (error) {
        console.error(error)
    }
} else {
    // @ts-ignore (define in dts)
    window.electron = electronAPI
    // @ts-ignore (define in dts)
    window.api = api
}
