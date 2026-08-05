import { computed, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { CreateTimeEntryBody } from '@solidtime/api'
import {
    emptyTimeEntry,
    getCurrentTimeEntry,
    useTimeEntryStopMutation,
    useTimeEntryCreateMutation,
} from './timeEntries.ts'
import { currentTimeEntry, lastTimeEntry } from './timerStore.ts'
import { currentMembershipId, useMyMemberships } from './myMemberships.ts'
import { isLoggedIn } from './oauth.ts'
import {
    isHttpResponseError,
    isNetworkError,
    reportServerReachable,
    reportServerUnreachable,
    serverReachable,
} from './reachability.ts'
import { dayjs } from './dayjs.ts'

const PROBE_INTERVAL_MS = 5000

/**
 * Reconciles the in-memory timer store against the server. This is the single
 * "server wins" point: every response overwrites the store, including
 * clearing it when the server reports no active timer. Mounted once at app
 * level so it runs whenever the main UI is up, not only on the table page.
 *
 * The query doubles as the reachability probe: its outcomes drive the
 * onlineManager, and while the server is unreachable it polls until a
 * success resumes the paused timer mutations.
 */
export function useTimerReconciliation() {
    const queryClient = useQueryClient()

    const {
        data: currentTimeEntryResponse,
        error: currentTimeEntryError,
        isError: currentTimeEntryResponseIsError,
    } = useQuery({
        queryKey: ['currentTimeEntry'],
        queryFn: async () => {
            try {
                const result = await getCurrentTimeEntry()
                reportServerReachable()
                return result
            } catch (error) {
                if (isNetworkError(error)) {
                    reportServerUnreachable()
                } else if (isHttpResponseError(error)) {
                    // Any HTTP response is a reachability success — including
                    // the 404 this endpoint answers when no timer is active
                    reportServerReachable()
                }
                throw error
            }
        },
        staleTime: 0, // Always refetch on window focus to catch external changes
        enabled: isLoggedIn,
        // The probe must keep running while the manager reports offline, and
        // one attempt per probe tick is enough
        networkMode: 'always',
        retry: false,
        refetchInterval: computed(() => (serverReachable.value ? false : PROBE_INTERVAL_MS)),
    })

    // While timer mutations are pending or paused, the server-wins overwrite
    // must be skipped — otherwise a reconnect could briefly resurrect a timer
    // whose stop is still in the queue. The invalidation after each mutation
    // settles re-runs the reconciliation with the post-mutation state.
    watch([currentTimeEntryResponseIsError, currentTimeEntryError], () => {
        if (currentTimeEntryResponseIsError.value) {
            // A network error carries no information about the timer; only an
            // HTTP response may clear the local state
            if (isNetworkError(currentTimeEntryError.value)) return
            if (queryClient.isMutating()) return
            // Only reset if we had a previously started timer (has an ID)
            // Don't reset if user is preparing a new time entry (no ID yet)
            if (currentTimeEntry.value.id !== '') {
                currentTimeEntry.value = { ...emptyTimeEntry }
            }
        }
    })

    watch(currentTimeEntryResponse, () => {
        if (queryClient.isMutating()) return
        if (currentTimeEntryResponse.value?.data) {
            currentTimeEntry.value = { ...currentTimeEntryResponse.value?.data }
        } else if (currentTimeEntry.value.id !== '') {
            // Server says no active time entry, but we have one locally
            // (e.g. stopped from another app) — clear it
            currentTimeEntry.value = { ...emptyTimeEntry }
        }
    })
}

/**
 * Composable for managing timer state and operations
 * Provides shared logic for starting/stopping timers across components
 * NOTE: This should only be used in the renderer process (browser context)
 */
export function useTimer() {
    // Get mutations for timer operations
    const timeEntryStop = useTimeEntryStopMutation()
    const timeEntryCreate = useTimeEntryCreateMutation()

    const { memberships, currentOrganizationId } = useMyMemberships()

    /**
     * Check if there's an active timer running
     */
    const isActive = computed(() => {
        if (currentTimeEntry.value) {
            return (
                currentTimeEntry.value.start !== '' &&
                currentTimeEntry.value.start !== null &&
                currentTimeEntry.value.end === null
            )
        }
        return false
    })

    /**
     * Stop the current timer
     * @param endTime - Optional end time (ISO string). If not provided, uses current time
     */
    async function stopTimer(endTime?: string) {
        const stoppedTimeEntry = { ...currentTimeEntry.value }
        const matchingMembershipId = memberships.value.find(
            (membership) => membership.organization.id === stoppedTimeEntry.organization_id
        )?.id
        if (matchingMembershipId) {
            currentMembershipId.value = matchingMembershipId
        }
        currentTimeEntry.value = { ...emptyTimeEntry }

        let end = endTime || dayjs().utc().format()
        if (stoppedTimeEntry.start && dayjs(end).isBefore(stoppedTimeEntry.start)) {
            // An entry cannot end before it starts. Possible when a workday
            // auto-stop ends at this machine's last input but the timer was
            // started elsewhere (e.g. web) while this machine sat idle.
            end = stoppedTimeEntry.start
        }

        await timeEntryStop.mutateAsync({
            ...stoppedTimeEntry,
            end,
        })
    }

    /**
     * Start a new timer using the current UI values.
     * Takes whatever is currently set on currentTimeEntry (description, project, task, etc.)
     * and starts a timer with those values. Does not fall back to lastTimeEntry.
     */
    function startTimer() {
        const startTime = dayjs().utc().format()
        const current = currentTimeEntry.value

        currentTimeEntry.value = {
            ...emptyTimeEntry,
            organization_id: currentOrganizationId.value ?? '',
            project_id: current.project_id,
            task_id: current.task_id,
            description: current.description,
            tags: current.tags,
            billable: current.billable,
            start: startTime,
        }

        const timeEntryToCreate: CreateTimeEntryBody = {
            ...currentTimeEntry.value,
            member_id: currentMembershipId.value!,
        }
        timeEntryCreate.mutate(timeEntryToCreate)
    }

    /**
     * Continue the last timer.
     * Starts a new timer using the values from lastTimeEntry (description, project, task, etc.).
     * Used when starting a timer from the widget, tray, or after discarding idle time.
     * @param start - Optional start time to backdate the timer.
     */
    function continueLastTimer(start?: string) {
        const startTime = start || dayjs().utc().format()

        if (lastTimeEntry.value && lastTimeEntry.value.start) {
            currentTimeEntry.value = {
                ...emptyTimeEntry,
                organization_id:
                    lastTimeEntry.value.organization_id || currentOrganizationId.value || '',
                project_id: lastTimeEntry.value.project_id,
                task_id: lastTimeEntry.value.task_id,
                description: lastTimeEntry.value.description,
                tags: lastTimeEntry.value.tags,
                billable: lastTimeEntry.value.billable,
                start: startTime,
            }
        } else {
            currentTimeEntry.value = {
                ...emptyTimeEntry,
                organization_id: currentOrganizationId.value ?? '',
                start: startTime,
            }
        }

        const timeEntryToCreate: CreateTimeEntryBody = {
            ...currentTimeEntry.value,
            member_id: currentMembershipId.value!,
        }
        timeEntryCreate.mutate(timeEntryToCreate)
    }

    return {
        currentTimeEntry,
        lastTimeEntry,
        isActive,
        stopTimer,
        startTimer,
        continueLastTimer,
        timeEntryStop,
        timeEntryCreate,
    }
}
