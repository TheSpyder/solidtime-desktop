import { dialog, ipcMain } from 'electron'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import type { Dayjs } from 'dayjs'
import { getMainWindow } from './mainWindow'
import { getAppSettings, getSetting, setSetting } from './settings'
import {
    lastInputTime,
    isUserIdle,
    subscribePresence,
    type BlockInfo,
    type UnblockInfo,
} from './presence'
import { suppressNextIdleDialog } from './idleMonitor'
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
let unsubscribePresence: (() => void) | null = null
// Start of the current uninterrupted activity streak; the backdated timer start
let activeSince: Dayjs | null = null
// Earliest time a new streak may begin. Prevents backdating across a boundary
// the system idle time can't see: a stopped timer or a streak-breaking block.
let streakFloor: Dayjs | null = null
// After "Not Now", suppress prompts until this time
let snoozeUntil: Dayjs | null = null
// While blocked (suspend/lock), the streak's fate is decided at unblock
let systemBlocked = false
let pendingStopPersisted = false
// Boundary stop carried over from a previous session, delivered when the
// renderer asks for it at startup
let launchPendingStop: string | null = null
let waitingForResponse = false

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

function handleBlocked({ lastInput }: BlockInfo) {
    systemBlocked = true

    if (isWorkdayTrackingEnabled() && isTimerRunning()) {
        // Work actually ended at the last input; trailing keyboard idle before
        // the block must not be included in an auto-stopped entry
        pendingStopPersisted = true
        void setSetting(PENDING_STOP_KEY, lastInput.utc().format())
    }
}

function handleUnblocked({ blockedAt, lastInput, unblockedAt, gapIsIdle }: UnblockInfo) {
    systemBlocked = false

    if (pendingStopPersisted) {
        pendingStopPersisted = false
        void setSetting(PENDING_STOP_KEY, '')
    }

    // Same-window rule: a block contained within one workday window is a
    // normal mid-day break (the idle monitor handles it); a block crossing
    // the boundary stops the timer at the last input before the block.
    if (
        isWorkdayTrackingEnabled() &&
        isTimerRunning() &&
        !isSameWorkdayWindow(blockedAt, unblockedAt)
    ) {
        console.log(`Block crossed the workday boundary, stopping timer at ${lastInput.format()}`)
        if (gapIsIdle) {
            // The auto-stop decides the timer's fate for this gap; the idle
            // keep/discard dialog must not also ask about it
            suppressNextIdleDialog()
        }
        getMainWindow()?.webContents.send('stopTimer', lastInput.utc().format())
    }

    // An input gap below the idle threshold is continuous activity — the
    // streak survives, consistent with the presence gap rule
    if (gapIsIdle) {
        resetStreak()
    }
}

// A shutdown never unblocks; persist the stop time and decide on next launch
function handleShutdown() {
    if (isWorkdayTrackingEnabled() && isTimerRunning()) {
        void setSetting(PENDING_STOP_KEY, lastInputTime().utc().format())
    }
}

function startWorkdayMonitoring() {
    if (workdayInterval) return

    console.log('Starting workday monitoring')
    resetStreak()
    unsubscribePresence = subscribePresence({
        // A pause long enough to count as idle breaks the streak
        onIdleStart: () => resetStreak(),
        onBlocked: handleBlocked,
        onUnblocked: handleUnblocked,
        onShutdown: handleShutdown,
    })
    workdayInterval = setInterval(workdayTick, TICK_INTERVAL_MS)
}

function stopWorkdayMonitoring() {
    if (workdayInterval) {
        clearInterval(workdayInterval)
        workdayInterval = null
    }
    if (unsubscribePresence) {
        unsubscribePresence()
        unsubscribePresence = null
    }
    systemBlocked = false
    resetStreak()
}

function resetStreak() {
    activeSince = null
    streakFloor = dayjs()
    snoozeUntil = null
}

function workdayTick() {
    const now = dayjs()

    // While blocked, the streak's fate is decided by the unblock handler;
    // while idle, the streak was already reset when the idle period began
    if (systemBlocked || isUserIdle()) return

    // While a timer runs, keep the floor at "now" so that when it stops, the
    // next streak starts at the stop time and the backdated entry can't
    // overlap the entry that was just tracked.
    if (isTimerRunning()) {
        resetStreak()
        return
    }

    // The streak accumulates regardless of the schedule — the schedule gates
    // only prompting, so pre-window activity is prompted for (and backdated
    // to) the moment the window opens
    if (activeSince === null) {
        let candidate = lastInputTime()
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
