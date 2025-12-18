import { test, expect } from '@playwright/test';

// This test assumes the Next 16 app is already running, e.g.:
//   cd test/integration/next-app-16-0-3 && pnpm dev
// on the same origin as baseURL.

test('button click triggers Server Action using updateTag', async ({
  page,
}) => {
  await page.goto('/update-tag-test');

  await expect(page.getByText('UpdateTag Test')).toBeVisible();

  const clicks = page.getByTestId('clicks');
  const before = await clicks.textContent();

  await page.getByRole('button', { name: 'Increment' }).click();

  // Wait for network and any navigation caused by the Server Action
  await page.waitForLoadState('networkidle');

  const after = await clicks.textContent();

  // Server Action should have run and updated the UI
  expect(after).not.toBe(before);

  // Ensure there is no error message about updateTag usage
  const errorLocator = page.getByText(
    'updateTag can only be called from within a Server Action',
    { exact: false },
  );
  await expect(errorLocator).toHaveCount(0);
});
