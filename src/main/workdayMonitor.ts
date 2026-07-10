import { dialog, ipcMain, powerMonitor } from 'electron'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import type { Dayjs } from 'dayjs'
import { getMainWindow } from './mainWindow'
import { getAppSettings, getSetting, setSetting } from './settings'
import { getIdleThresholdSeconds, lastInputTime, suppressNextIdleDialog } from './idleMonitor'
import { isTimerRunning } from './timerState'
import {
    isSameWorkdayWindow,
    isWithinWorkday,
    isWorkdayTrackingEnabled,
    updateWorkdaySchedule,
} from './schedule'

// "Track my workday": when the user has been continuously active for the
// configured threshold with no timer running, prompt them (within the workday
// window) to start a timer backdated to the start of the activity streak.
// When a block (suspend/lock/shutdown) crosses a workday boundary while a
// timer is running, silently stop the timer at the block time.
//
// NOTE: this module's power event handlers must be registered BEFORE the idle
// monitor's (initializeWorkdayMonitor before initializeIdleMonitor), so an
// auto-stop can suppress the idle dialog for the same unblock event.

dayjs.extend(utc)

const TICK_INTERVAL_MS = 5000
// Persisted so a boundary crossing survives the app quitting during the block
const PENDING_STOP_KEY = 'workday_pending_stop'

export interface WorkdaySettings {
    enabled: boolean
    reminderThresholdMinutes: number
    days: number[] // 0 = Sunday (dayjs convention)
    startTime: string // 'HH:mm' local time
    endTime: string // 'HH:mm' local time
}

let thresholdSeconds = 600

let workdayInterval: NodeJS.Timeout | null = null
// Start of the current uninterrupted activity streak; the backdated timer start
let activeSince: Dayjs | null = null
// Earliest time a new streak may begin. Prevents backdating across a boundary
// the system idle time can't see: a stopped timer or a streak-breaking block.
let streakFloor: Dayjs | null = null
// After "Not Now", suppress prompts until this time
let snoozeUntil: Dayjs | null = null
// Block (suspend/lock) state; the unblock handler decides the streak's fate
let systemBlocked = false
let blockedAt: Dayjs | null = null
// Where an auto-stopped timer ends: the last input before the block
let stopAt: Dayjs | null = null
let pendingStopPersisted = false
let screenLocked = false
// Boundary stop carried over from a previous session, delivered when the
// renderer asks for it at startup
let launchPendingStop: string | null = null
let waitingForResponse = false
let powerEventsRegistered = false

export async function initializeWorkdayMonitor() {
    const appSettings = await getAppSettings()
    thresholdSeconds = appSettings.workdayReminderThresholdMinutes * 60
    updateWorkdaySchedule({
        enabled: appSettings.workdayTrackingEnabled,
        days: appSettings.workdayDays,
        startTime: appSettings.workdayStartTime,
        endTime: appSettings.workdayEndTime,
    })

    console.log('Workday monitor initialized with settings:', {
        enabled: appSettings.workdayTrackingEnabled,
        thresholdSeconds,
        days: appSettings.workdayDays,
        window: `${appSettings.workdayStartTime}-${appSettings.workdayEndTime}`,
    })

    await loadPendingStopFromPreviousSession()

    registerWorkdayListeners()
    registerPowerMonitorEvents()

    if (isWorkdayTrackingEnabled()) {
        startWorkdayMonitoring()
    }
}

/**
 * A block from a previous session (e.g. shutdown, or the app quit while
 * suspended) may have crossed a workday boundary. If so, hold the stop until
 * the renderer collects it via getPendingWorkdayStop.
 */
async function loadPendingStopFromPreviousSession() {
    const pendingStopValue = await getSetting(PENDING_STOP_KEY)
    if (!pendingStopValue) return

    await setSetting(PENDING_STOP_KEY, '')

    const blockTime = dayjs(pendingStopValue)
    if (blockTime.isValid() && !isSameWorkdayWindow(blockTime, dayjs())) {
        launchPendingStop = blockTime.utc().format()
        console.log('Workday boundary stop pending from previous session:', launchPendingStop)
    }
}

function registerWorkdayListeners() {
    ipcMain.on('updateWorkdaySettings', (_event, settings: WorkdaySettings) => {
        console.log('Workday settings updated:', settings)

        if (
            typeof settings.reminderThresholdMinutes === 'number' &&
            settings.reminderThresholdMinutes > 0
        ) {
            thresholdSeconds = settings.reminderThresholdMinutes * 60
        }
        updateWorkdaySchedule(settings)

        if (isWorkdayTrackingEnabled()) {
            startWorkdayMonitoring()
        } else {
            stopWorkdayMonitoring()
        }
    })

    // The renderer collects a previous session's boundary stop once it is
    // ready to stop the timer (a push at startup could race its listeners)
    ipcMain.handle('getPendingWorkdayStop', () => {
        const pendingStop = launchPendingStop
        launchPendingStop = null
        return pendingStop
    })
}

function registerPowerMonitorEvents() {
    if (powerEventsRegistered) return
    powerEventsRegistered = true

    powerMonitor.on('suspend', () => handleBlock('system suspend'))
    powerMonitor.on('lock-screen', () => {
        screenLocked = true
        handleBlock('screen locked')
    })
    powerMonitor.on('resume', () => {
        // May still be locked; the unblock then happens on unlock-screen
        if (screenLocked) return
        handleUnblock('system resume')
    })
    powerMonitor.on('unlock-screen', () => {
        screenLocked = false
        handleUnblock('screen unlocked')
    })

    // A shutdown never unblocks; persist the stop time and decide on next launch
    powerMonitor.on('shutdown', () => {
        if (isWorkdayTrackingEnabled() && isTimerRunning()) {
            void setSetting(PENDING_STOP_KEY, lastInputTime().utc().format())
        }
    })

    // macOS multi-user switching
    powerMonitor.on('user-did-resign-active', () => handleBlock('user session resigned'))
    powerMonitor.on('user-did-become-active', () => handleUnblock('user session active'))
}

function handleBlock(reason: string) {
    if (systemBlocked) return // e.g. lock followed by suspend; keep the first block time
    systemBlocked = true
    blockedAt = dayjs()
    // Work actually ended at the last input; trailing keyboard idle before
    // the block must not be included in an auto-stopped entry
    stopAt = lastInputTime()

    console.log(`Workday monitor blocked: ${reason}`)

    if (isWorkdayTrackingEnabled() && isTimerRunning()) {
        pendingStopPersisted = true
        void setSetting(PENDING_STOP_KEY, stopAt.utc().format())
    }
}

function handleUnblock(reason: string) {
    if (!systemBlocked) return
    systemBlocked = false

    const blockStart = blockedAt
    const stopTime = stopAt
    blockedAt = null
    stopAt = null
    if (pendingStopPersisted) {
        pendingStopPersisted = false
        void setSetting(PENDING_STOP_KEY, '')
    }
    if (!blockStart || !stopTime) return

    const now = dayjs()
    console.log(`Workday monitor unblocked: ${reason}`)

    // Same-window rule: a block contained within one workday window is a
    // normal mid-day break (the idle monitor handles it); a block crossing
    // the boundary stops the timer at the last input before the block.
    if (isWorkdayTrackingEnabled() && isTimerRunning() && !isSameWorkdayWindow(blockStart, now)) {
        console.log(`Block crossed the workday boundary, stopping timer at ${stopTime.format()}`)
        suppressNextIdleDialog()
        getMainWindow()?.webContents.send('stopTimer', stopTime.utc().format())
    }

    // An input gap below the idle threshold is continuous activity — the
    // streak survives, consistent with the idle monitor's gap rule (measured
    // from the last input, so pre-block keyboard idle counts)
    if (now.diff(stopTime, 'second') >= getIdleThresholdSeconds()) {
        resetStreak()
    }
}

function startWorkdayMonitoring() {
    if (workdayInterval) return

    console.log('Starting workday monitoring')
    resetStreak()
    workdayInterval = setInterval(workdayTick, TICK_INTERVAL_MS)
}

function stopWorkdayMonitoring() {
    if (workdayInterval) {
        clearInterval(workdayInterval)
        workdayInterval = null
    }
    resetStreak()
}

function resetStreak() {
    activeSince = null
    streakFloor = dayjs()
    snoozeUntil = null
}

function workdayTick() {
    const now = dayjs()

    // While blocked, the streak's fate is decided by the unblock handler
    if (systemBlocked) return

    // While a timer runs, keep the floor at "now" so that when it stops, the
    // next streak starts at the stop time and the backdated entry can't
    // overlap the entry that was just tracked.
    if (isTimerRunning()) {
        resetStreak()
        return
    }

    const idleSince = lastInputTime()
    if (now.diff(idleSince, 'second') >= getIdleThresholdSeconds()) {
        // Pause long enough to count as idle breaks the streak
        resetStreak()
        return
    }

    // The streak accumulates regardless of the schedule — the schedule gates
    // only prompting, so pre-window activity is prompted for (and backdated
    // to) the moment the window opens
    if (activeSince === null) {
        let candidate = idleSince
        if (streakFloor && candidate.isBefore(streakFloor)) candidate = streakFloor
        activeSince = candidate
    }

    if (waitingForResponse) return
    if (snoozeUntil && now.isBefore(snoozeUntil)) return
    if (!isWithinWorkday(now)) return

    if (now.diff(activeSince, 'second') >= thresholdSeconds) {
        void showReminderDialog(activeSince)
    }
}

async function showReminderDialog(streakStart: Dayjs) {
    const mainWindow = getMainWindow()
    if (!mainWindow) return

    waitingForResponse = true

    const streakStartUtc = streakStart.utc().format()
    const startLabel = streakStart.format('HH:mm')

    try {
        mainWindow.flashFrame(true)

        // Native dialogs cannot be updated once shown, so only absolute
        // times appear here — a growing duration would go stale on screen
        const result = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: 'No Timer Running',
            message: "You're working without a running timer",
            detail: `You've been active since ${startLabel} with no timer running.\n\nStart a timer backdated to ${startLabel}?`,
            buttons: ['Start Timer', 'Not Now'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        })
        mainWindow.flashFrame(false)

        if (result.response === 0) {
            // Reset before notifying the renderer so the next tick can't
            // re-prompt while the timer start is in flight
            resetStreak()
            mainWindow.webContents.send('workdayReminderResponse', {
                choice: result.response,
                activeSince: streakStartUtc,
            })
        } else {
            // Keep the streak (a later prompt still backdates to its true
            // start) but stay quiet for another full threshold
            snoozeUntil = dayjs().add(thresholdSeconds, 'second')
        }
    } catch (error) {
        console.error('Error showing workday reminder dialog:', error)
    } finally {
        waitingForResponse = false
    }
}
