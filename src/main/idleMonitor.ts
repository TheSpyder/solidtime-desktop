import { app, powerMonitor, ipcMain, dialog } from 'electron'
import { getMainWindow } from './mainWindow'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import duration from 'dayjs/plugin/duration'
import type { Dayjs } from 'dayjs'
import { db } from './db/client'
import { activityPeriods, validateNewActivityPeriod } from './db/schema'
import { getAppSettings } from './settings'
import { isTimerRunning } from './timerState'

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

let idleCheckInterval: NodeJS.Timeout | null = null
let isIdle = false
let idleStartTime: Dayjs | null = null
let activeStartTime: Dayjs | null = null
let idleThreshold = 300
let idleDetectionEnabled = true
let waitingForUserResponse = false // Track if we're waiting for idle dialog response
let powerEventsRegistered = false
let isScreenLocked = false // Defer resume handling until unlock so the dialog uses the unlock time
let lastInputBeforeBlock: Dayjs | null = null // Where idle starts if the gap crosses the workday
let suppressNextDialog = false // Set by the workday monitor when auto-stop should replace the dialog
// TODO: rename
let inputFloor: Dayjs | null = null

/**
 * The moment of the last user input, derived from the system idle time.
 */
export function lastInputTime(): Dayjs {
    const lastInput = dayjs().subtract(powerMonitor.getSystemIdleTime(), 'seconds')
    return inputFloor && lastInput.isBefore(inputFloor) ? inputFloor : lastInput
}

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
    idleThreshold = appSettings.idleThresholdMinutes * 60 // Convert to seconds
    idleDetectionEnabled = appSettings.idleDetectionEnabled

    console.log('Idle monitor initialized with settings:', {
        idleThreshold,
        idleDetectionEnabled,
    })

    registerIdleMonitorListeners()
    registerPowerMonitorEvents()

    // Start monitoring if idle detection is enabled (regardless of timer state)
    if (idleDetectionEnabled) {
        startIdleMonitoring()
    }
}

function registerIdleMonitorListeners() {
    // Listen for idle threshold updates from renderer
    ipcMain.on('updateIdleThreshold', (_event, thresholdMinutes: number) => {
        if (typeof thresholdMinutes === 'number' && thresholdMinutes > 0) {
            idleThreshold = thresholdMinutes * 60 // Convert minutes to seconds
            console.log('Idle threshold updated to:', idleThreshold, 'seconds')
        } else {
            console.warn('Invalid idle threshold value:', thresholdMinutes)
        }
    })

    // Listen for idle detection enabled/disabled from renderer
    ipcMain.on('updateIdleDetectionEnabled', (_event, enabled: boolean) => {
        console.log('Idle detection enabled:', enabled, idleThreshold)

        idleDetectionEnabled = enabled
        if (!enabled && idleCheckInterval) {
            stopIdleMonitoring()
        } else if (enabled && !idleCheckInterval) {
            startIdleMonitoring()
        }
    })
}

function transitionToIdle(idleStart: Dayjs) {
    if (isIdle) return // Guard against double-fire (e.g. macOS suspend firing twice)

    isIdle = true
    idleStartTime = idleStart

    console.log(`System became idle at ${idleStartTime.toISOString()}`)

    // Save the active period that just ended
    if (activeStartTime) {
        // Ensure the end time is not before the start time due to timing precision
        const endTime = idleStartTime.isBefore(activeStartTime) ? activeStartTime : idleStartTime

        saveActivityPeriod(activeStartTime.utc().format(), endTime.utc().format(), false)
        activeStartTime = null
    }
}

function transitionToActive() {
    if (isScreenLocked) return // Stay idle until the screen is unlocked
    if (!isIdle || !idleStartTime) return // Guard against double-fire

    const idleEnd = dayjs()
    const idleDurationSeconds = idleEnd.diff(idleStartTime, 'seconds')

    console.log(
        `System became active at ${idleEnd.toISOString()}, idle duration: ${idleDurationSeconds}s`
    )

    // Capture the idle period info before resetting state
    const capturedIdleStart = idleStartTime.utc().format()
    const capturedIdleEnd = idleEnd.utc().format()
    const capturedDuration = idleDurationSeconds

    // Reset idle state and resume activity tracking immediately
    isIdle = false
    idleStartTime = null
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

        // Show dialog asynchronously without blocking the interval
        showIdleDialog(capturedIdleStart, capturedIdleEnd, capturedDuration)
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

/**
 * The system blocked (suspend, lock, user switch) while monitoring. Whether
 * this counts as idle is decided at unblock time by comparing the gap against
 * the idle threshold — a short sleep or lock is not idle, the same as a short
 * pause at the keyboard.
 */
function handleBlock(reason: string) {
    console.log(`powerMonitor: ${reason}`)
    // Stop the polling interval BEFORE recording the block
    // to prevent a final tick from mutating state mid-transition
    clearIdleCheckInterval()
    if (!isIdle && lastInputBeforeBlock === null) {
        // Keyboard idle leading into the block counts toward the gap, the
        // same as if the user had stayed at the desk
        lastInputBeforeBlock = lastInputTime()
    }
}

/**
 * The system unblocked (resume, unlock, user switch back). Classify the gap:
 * already idle before the block → normal resume flow; no input for ≥ the
 * threshold → an idle period from the last input; otherwise continuous
 * activity.
 */
function handleUnblock(reason: string) {
    console.log(`powerMonitor: ${reason}`)
    if (isIdle) {
        transitionToActive()
        inputFloor = dayjs() // The recorded idle ends here; don't re-count it
    } else if (lastInputBeforeBlock !== null) {
        const gapSeconds = dayjs().diff(lastInputBeforeBlock, 'seconds')
        if (gapSeconds >= idleThreshold) {
            transitionToIdle(lastInputBeforeBlock)
            transitionToActive()
            inputFloor = dayjs() // The recorded idle ends here; don't re-count it
        } else {
            console.log(`Input gap of ${gapSeconds}s is below the idle threshold, staying active`)
        }
    }
    lastInputBeforeBlock = null
    suppressNextDialog = false // Never let a suppression outlive its unblock
    restartIdleCheckInterval()
}

function registerPowerMonitorEvents() {
    if (powerEventsRegistered) return
    powerEventsRegistered = true

    powerMonitor.on('suspend', () => {
        if (!idleDetectionEnabled) return
        handleBlock('system suspend')
    })

    powerMonitor.on('lock-screen', () => {
        isScreenLocked = true
        if (!idleDetectionEnabled) return
        handleBlock('screen locked')
    })

    powerMonitor.on('resume', () => {
        if (!idleDetectionEnabled) return
        if (isScreenLocked) {
            console.log('powerMonitor: resume with screen still locked, waiting for unlock')
            return
        }
        handleUnblock('system resume')
    })

    powerMonitor.on('unlock-screen', () => {
        isScreenLocked = false
        if (!idleDetectionEnabled) return
        handleUnblock('screen unlocked')
    })

    // macOS and Linux emit an event when the system is about to shut down.
    // Delay to save the current period and run normal app.quit() handlers.
    // Shutdown always ends the active period at the shutdown time; the gap
    // classification doesn't apply because there is no unblock to measure to.
    powerMonitor.on('shutdown', (event?: Electron.Event) => {
        event?.preventDefault()
        console.log('powerMonitor: system shutdown')
        if (idleDetectionEnabled) {
            clearIdleCheckInterval()
            transitionToIdle(dayjs())
        }
        app.quit()
    })

    // macOS specific events for multi user switching
    powerMonitor.on('user-did-resign-active', () => {
        if (!idleDetectionEnabled) return
        handleBlock('user session resigned active')
    })

    powerMonitor.on('user-did-become-active', () => {
        if (!idleDetectionEnabled) return
        handleUnblock('user session became active')
    })
}

function clearIdleCheckInterval() {
    if (idleCheckInterval) {
        clearInterval(idleCheckInterval)
        idleCheckInterval = null
    }
}

function restartIdleCheckInterval() {
    if (!idleDetectionEnabled) return
    clearIdleCheckInterval()
    idleCheckInterval = setInterval(() => {
        const idleSince = lastInputTime()

        if (dayjs().diff(idleSince, 'seconds') >= idleThreshold) {
            transitionToIdle(idleSince)
        } else {
            transitionToActive()
        }
    }, 1000)
}

function startIdleMonitoring() {
    if (idleCheckInterval) {
        console.log('Idle monitoring already running, skipping start')
        return // Already monitoring
    }

    console.log('Starting idle monitoring')

    isIdle = false
    idleStartTime = null
    lastInputBeforeBlock = null
    suppressNextDialog = false // A suppression must not survive a monitoring restart

    // Check current idle state immediately to set correct initial state
    const idleSince = lastInputTime()
    if (dayjs().diff(idleSince, 'seconds') >= idleThreshold) {
        // System is already idle when monitoring starts
        isIdle = true
        idleStartTime = idleSince
        activeStartTime = null
        console.log(
            `System already idle when monitoring started. Idle since: ${idleStartTime.toISOString()}`
        )
    } else {
        // System is active, start tracking from now
        activeStartTime = dayjs()
    }

    // Check idle state every second
    restartIdleCheckInterval()
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
    // Save the current active period if we're stopping while active
    if (activeStartTime && !isIdle) {
        const now = dayjs()
        await saveActivityPeriod(activeStartTime.utc().format(), now.utc().format(), false)
    }

    // Save current idle period if we're stopping while idle
    if (idleStartTime && isIdle) {
        const now = dayjs()
        await saveActivityPeriod(idleStartTime.utc().format(), now.utc().format(), true)
    }

    clearIdleCheckInterval()
    isIdle = false
    idleStartTime = null
    activeStartTime = null
    lastInputBeforeBlock = null
    waitingForUserResponse = false
}

/**
 * Gets the current ongoing activity period (not yet saved to database)
 * Returns null if there's no ongoing period or if waiting for user response
 */
export function getCurrentActivityPeriod(): { start: string; end: string; isIdle: boolean } | null {
    const now = dayjs()

    if (isIdle && idleStartTime) {
        // Currently in an idle period
        return {
            start: idleStartTime.utc().format(),
            end: now.utc().format(),
            isIdle: true,
        }
    } else if (!isIdle && activeStartTime) {
        // Currently in an active period
        return {
            start: activeStartTime.utc().format(),
            end: now.utc().format(),
            isIdle: false,
        }
    }

    return null
}

/**
 * Current idle threshold in seconds. Also used by the timer reminder as the
 * activity-continuity gap: a pause shorter than this keeps an active streak alive.
 */
export function getIdleThresholdSeconds(): number {
    return idleThreshold
}

export { startIdleMonitoring, stopIdleMonitoring }
