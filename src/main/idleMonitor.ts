import { app, ipcMain, dialog } from 'electron'
import { getMainWindow } from './mainWindow'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import duration from 'dayjs/plugin/duration'
import type { Dayjs } from 'dayjs'
import { db } from './db/client'
import { activityPeriods, validateNewActivityPeriod } from './db/schema'
import { getAppSettings } from './settings'
import { isTimerRunning } from './timerState'
import { isSessionActive, onSessionStateChanged } from './connectionState'
import { currentIdleStart, isUserIdle, subscribePresence } from './presence'
import { pauseActivityTracking, resumeActivityTracking } from './activityTracker'

// Idle detection policy on top of the shared presence signal: records
// active/idle periods to the database and, when the user returns from idle
// with a timer running, asks the renderer whether to keep or discard the
// idle time.

dayjs.extend(utc)
dayjs.extend(duration)

// Helper functions for formatting (replicate UI package functionality for main process)
function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`
    } else {
        return `${secs}s`
    }
}

/** Formats an ISO timestamp as local HH:mm:ss for the idle dialog. */
function formatTime(isoString: string): string {
    return dayjs(isoString).format('HH:mm:ss')
}

let unsubscribePresence: (() => void) | null = null
let activeStartTime: Dayjs | null = null
let idleDetectionEnabled = true
let waitingForUserResponse = false // Track if we're waiting for idle dialog response
let suppressNextDialog = false // Set by the workday monitor when auto-stop should replace the dialog

/**
 * Suppresses the idle dialog for the next transition to active, saving the
 * idle period silently instead. Called by the workday monitor when a
 * workday-boundary auto-stop already decides the timer's fate for that gap.
 */
export function suppressNextIdleDialog() {
    suppressNextDialog = true
}

export async function initializeIdleMonitor() {
    // Load settings from database
    const appSettings = await getAppSettings()
    idleDetectionEnabled = appSettings.idleDetectionEnabled

    console.log('Idle monitor initialized with settings:', {
        idleDetectionEnabled,
    })

    registerIdleMonitorListeners()

    // Monitoring runs only while logged in with a confirmed connection;
    // setting-enabled AND session-active are both required
    onSessionStateChanged((active) => {
        if (active && idleDetectionEnabled) {
            startIdleMonitoring()
        } else if (!active) {
            void stopIdleMonitoring()
        }
    })
    if (idleDetectionEnabled && isSessionActive()) {
        startIdleMonitoring()
    }
}

function registerIdleMonitorListeners() {
    // Listen for idle detection enabled/disabled from renderer
    ipcMain.on('updateIdleDetectionEnabled', (_event, enabled: boolean) => {
        console.log('Idle detection enabled:', enabled)

        idleDetectionEnabled = enabled
        if (!enabled) {
            void stopIdleMonitoring()
        } else if (isSessionActive()) {
            startIdleMonitoring()
        }
    })
}

function handleIdleStart(idleStart: Dayjs) {
    // idleStart may be retroactive (now - system idle time).
    void pauseActivityTracking(idleStart.toDate())

    // Save the active period that just ended
    if (activeStartTime) {
        // Ensure the end time is not before the start time due to timing precision
        const endTime = idleStart.isBefore(activeStartTime) ? activeStartTime : idleStart

        saveActivityPeriod(activeStartTime.utc().format(), endTime.utc().format(), false)
        activeStartTime = null
    }
}

function handleIdleEnd(idleStart: Dayjs, idleEnd: Dayjs) {
    const idleDurationSeconds = idleEnd.diff(idleStart, 'seconds')

    // Capture the idle period info and resume activity tracking immediately
    const capturedIdleStart = idleStart.utc().format()
    const capturedIdleEnd = idleEnd.utc().format()
    activeStartTime = idleEnd
    resumeActivityTracking()

    // Always record the idle period; a dialog (if shown) only decides what
    // happens to the running time entry, it doesn't gate this record
    saveActivityPeriod(capturedIdleStart, capturedIdleEnd, true)

    if (suppressNextDialog) {
        // A workday auto-stop already decided the timer's fate for this gap
        suppressNextDialog = false
        return
    }

    // Only one dialog at a time; a gap ending while a dialog is already open
    // goes unrecorded (but is still saved above)
    if (isTimerRunning() && !waitingForUserResponse) {
        waitingForUserResponse = true

        // Show dialog asynchronously without blocking the presence poll
        showIdleDialog(capturedIdleStart, capturedIdleEnd, idleDurationSeconds)
            .then(() => {
                waitingForUserResponse = false
            })
            .catch((error) => {
                console.error('Error showing idle dialog:', error)
                waitingForUserResponse = false
            })
    }
}

function startIdleMonitoring() {
    if (unsubscribePresence) {
        console.log('Idle monitoring already running, skipping start')
        return // Already monitoring
    }

    console.log('Starting idle monitoring')

    suppressNextDialog = false // A suppression must not survive a monitoring restart

    unsubscribePresence = subscribePresence({
        onIdleStart: handleIdleStart,
        onIdleEnd: handleIdleEnd,
    })

    // The presence signal may already classify the user as idle (it starts
    // from the system idle clock); the eventual idle period then reaches back
    // to the last input, and there is no active period to track yet
    activeStartTime = isUserIdle() ? null : dayjs()
}

async function saveActivityPeriod(start: string, end: string, isIdlePeriod: boolean) {
    try {
        const newPeriod = {
            start,
            end,
            isIdle: isIdlePeriod,
        }

        // Validate the period before insertion
        validateNewActivityPeriod(newPeriod)

        await db.insert(activityPeriods).values(newPeriod)
        console.log(`Saved ${isIdlePeriod ? 'idle' : 'active'} period: ${start} to ${end}`)
    } catch (error) {
        console.error('Failed to save activity period:', error)
        // Log detailed error for debugging
        if (error instanceof Error) {
            console.error('Error details:', error.message)
        }
    }
}

async function showIdleDialog(idleStartTime: string, idleEndTime: string, durationSeconds: number) {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
        return
    }

    const formattedDuration = formatDuration(durationSeconds)
    const startTime = formatTime(idleStartTime)
    const endTime = formatTime(idleEndTime)

    if (mainWindow.isMinimized()) {
        mainWindow.restore()
    }
    if (!mainWindow.isVisible()) {
        mainWindow.show()
    }
    mainWindow.flashFrame(true)
    app.focus({ steal: true })
    mainWindow.focus()

    let result: Electron.MessageBoxReturnValue
    try {
        result = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: 'Idle Time Detected',
            message: 'You were away from your computer',
            detail: `Idle Duration: ${formattedDuration}\nIdle Start: ${startTime}\nActivity Resumed: ${endTime}\n\nWhat would you like to do with the idle time?`,
            buttons: ['Keep Idle Time', 'Discard Idle Time', 'Discard & Start New Timer'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
        })
    } finally {
        mainWindow.flashFrame(false)
    }

    console.log('Idle dialog choice:', result.response)

    // The renderer handles the choice (keep, or backdate the stop / restart);
    mainWindow.webContents.send('idleDialogResponse', {
        choice: result.response,
        idleStartTime,
        idleEndTime,
    })
}

async function stopIdleMonitoring() {
    // When not monitoring, the presence state belongs to other consumers
    // and no period must be recorded from it
    if (!unsubscribePresence) return
    unsubscribePresence()
    unsubscribePresence = null

    const now = dayjs()
    const idleStart = currentIdleStart()

    // Save current idle period if we're stopping while idle
    if (isUserIdle() && idleStart) {
        await saveActivityPeriod(idleStart.utc().format(), now.utc().format(), true)
        // Resume when idle detection is disabled mid-idle.
        resumeActivityTracking()
    }

    // Save the current active period if we're stopping while active
    if (activeStartTime && !isUserIdle()) {
        await saveActivityPeriod(activeStartTime.utc().format(), now.utc().format(), false)
    }

    activeStartTime = null
    waitingForUserResponse = false
}

/**
 * Gets the current ongoing activity period (not yet saved to database)
 * Returns null if there's no ongoing period or if monitoring is stopped
 */
export function getCurrentActivityPeriod(): { start: string; end: string; isIdle: boolean } | null {
    if (!unsubscribePresence) {
        return null
    }

    const now = dayjs()
    const idleStart = currentIdleStart()

    if (isUserIdle() && idleStart) {
        // Currently in an idle period
        return {
            start: idleStart.utc().format(),
            end: now.utc().format(),
            isIdle: true,
        }
    } else if (!isUserIdle() && activeStartTime) {
        // Currently in an active period
        return {
            start: activeStartTime.utc().format(),
            end: now.utc().format(),
            isIdle: false,
        }
    }

    return null
}

export { startIdleMonitoring, stopIdleMonitoring }
