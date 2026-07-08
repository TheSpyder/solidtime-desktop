import { test, expect } from '../fixtures/electron-test'

test.describe('Server unavailable', () => {
    test('shows a connection error with retry instead of loading forever', async ({
        page,
        mockState,
    }) => {
        test.setTimeout(90_000)

        // Sanity-reference the fixture so the mocks (and auth seed) are set up.
        void mockState

        // Refuse every API request, as if the configured server is down.
        // Registered after the catch-all, so it wins for matching requests
        // (Playwright runs handlers last-registered-first); falling back
        // hands the request to the catch-all mock again.
        let serverDown = true
        await page.route(/mock\.solidtime\.io/, async (route) => {
            if (serverDown) {
                await route.abort('connectionrefused')
            } else {
                await route.fallback()
            }
        })

        // Re-bootstrap cold: logged in (token in localStorage) but the server
        // is unreachable.
        await page.reload({ waitUntil: 'domcontentloaded' })

        // The pre-fix build sits on "Loading…" forever; the fixed build
        // surfaces a connection error once retries are exhausted.
        await expect(page.getByText(/could not connect/i)).toBeVisible({ timeout: 30_000 })
        await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
        await expect(page.getByText('Loading…')).toHaveCount(0)

        // Bring the server back and retry — the app must recover without a
        // restart.
        serverDown = false
        await page.getByRole('button', { name: 'Retry' }).click()
        await expect(page.getByText('Implement navigation component').first()).toBeVisible({
            timeout: 15_000,
        })
    })
})
