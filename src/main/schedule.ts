import type { Dayjs } from 'dayjs'

// Shared workday schedule: which days of the week and which time-of-day window
// count as the user's workday. Owned/updated by the workday monitor's settings
// flow; consulted by the workday monitor (when to prompt, boundary crossings).

export interface WorkdaySchedule {
    enabled: boolean
    days: number[] // 0 = Sunday (dayjs convention)
    startTime: string // 'HH:mm' local time
    endTime: string // 'HH:mm' local time
}

let workdayEnabled = false
let workdayDays: number[] = [1, 2, 3, 4, 5]
let windowStartTime = '09:00'
let windowEndTime = '17:00'

export function updateWorkdaySchedule(schedule: WorkdaySchedule) {
    workdayEnabled = schedule.enabled
    if (Array.isArray(schedule.days)) {
        workdayDays = schedule.days
    }
    windowStartTime = schedule.startTime
    windowEndTime = schedule.endTime
}

export function isWorkdayTrackingEnabled(): boolean {
    return workdayEnabled
}

function parseTimeOfDay(time: string): number {
    const [hours, minutes] = time.split(':').map(Number)
    return hours * 60 + minutes
}

export function isWithinWorkday(at: Dayjs): boolean {
    if (!workdayDays.includes(at.day())) return false
    const minutes = at.hour() * 60 + at.minute()
    return minutes >= parseTimeOfDay(windowStartTime) && minutes < parseTimeOfDay(windowEndTime)
}

/**
 * True if both moments fall within the same workday window (same calendar
 * day and both inside the window). A block spanning outside this is a
 * workday boundary crossing.
 */
export function isSameWorkdayWindow(a: Dayjs, b: Dayjs): boolean {
    return a.isSame(b, 'day') && isWithinWorkday(a) && isWithinWorkday(b)
}
