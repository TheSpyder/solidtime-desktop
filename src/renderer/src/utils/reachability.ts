import { ref } from 'vue'
import { onlineManager } from '@tanstack/vue-query'
import { isAxiosError } from 'axios'

// TanStack's onlineManager normally follows navigator.onLine, which stays
// true when the server is unreachable over a working network. Instead it is
// driven from actual request outcomes: a network error (no HTTP response)
// from a timer mutation or the reconciliation query flips it offline, which
// pauses timer mutations until the reconciliation probe succeeds again.
// HTTP responses of any status are reachability successes.

onlineManager.setEventListener(() => () => {})

export const serverReachable = ref(true)

onlineManager.subscribe((online) => {
    serverReachable.value = online
})

export function isNetworkError(error: unknown): boolean {
    return isAxiosError(error) && !error.response
}

export function isHttpResponseError(error: unknown): boolean {
    return isAxiosError(error) && !!error.response
}

export function reportServerUnreachable() {
    onlineManager.setOnline(false)
}

export function reportServerReachable() {
    onlineManager.setOnline(true)
}
