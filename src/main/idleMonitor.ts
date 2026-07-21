import { ipcMain, dialog } from 'electron'
import { getMainWindow } from './mainWindow'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import duration from 'dayjs/plugin/duration'
import type { Dayjs } from 'dayjs'
import { db } from './db/client'
import { activityPeriods, validateNewActivityPeriod } from './db/schema'
import { getAppSettings } from './settings'
import { isTimerRunning } from './timerState'
import { currentIdleStart, isUserIdle, subscribePresence } from './presence'

// Idle detection policy on top of the shared presence signal: records
// active/idle periods to the database and, when the user returns from idle
// with a timer running, asks whether to keep or discard the idle time.

// Configure dayjs for main process
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

    // Start monitoring if idle detection is enabled (regardless of timer state)
    if (idleDetectionEnabled) {
        startIdleMonitoring()
    }
}

function registerIdleMonitorListeners() {
    // Listen for idle detection enabled/disabled from renderer
    ipcMain.on('updateIdleDetectionEnabled', (_event, enabled: boolean) => {
        console.log('Idle detection enabled:', enabled)

        idleDetectionEnabled = enabled
        if (!enabled) {
            stopIdleMonitoring()
        } else {
            startIdleMonitoring()
        }
    })
}

function handleIdleStart(idleStart: Dayjs) {
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

    // Only show dialog if timer is running and we're not already waiting for a response
    // This prevents multiple dialogs from appearing
    if (suppressNextDialog) {
        // A workday auto-stop already handled the timer for this gap;
        // record the idle period without asking
        suppressNextDialog = false
        saveActivityPeriod(capturedIdleStart, capturedIdleEnd, true)
    } else if (isTimerRunning() && !waitingForUserResponse) {
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
    } else if (!isTimerRunning()) {
        // If timer is not running, just save the idle period automatically
        saveActivityPeriod(capturedIdleStart, capturedIdleEnd, true)
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

    mainWindow.flashFrame(true)

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Idle Time Detected',
        message: 'You were away from your computer',
        detail: `Idle Duration: ${formattedDuration}\nIdle Start: ${startTime}\nActivity Resumed: ${endTime}\n\nWhat would you like to do with the idle time?`,
        buttons: ['Keep Idle Time', 'Discard Idle Time', 'Discard & Start New Timer'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    })
    mainWindow.flashFrame(false)

    // Handle the user's choice
    if (result.response === 0) {
        // Keep Idle Time - save the idle period
        await saveActivityPeriod(idleStartTime, idleEndTime, true)
    } else if (result.response === 1) {
        // Discard Idle Time - don't save anything
        console.log('User discarded idle time')
    } else if (result.response === 2) {
        // Discard & Start New Timer - don't save idle time
        console.log('User discarded idle time and will start new timer')
    }

    // Send the user's choice to renderer
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
