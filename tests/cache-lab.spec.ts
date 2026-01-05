import { test, expect } from '@playwright/test';

// These tests assume the Cache Components Next.js app is already running on the same origin as baseURL.
// Recommended:
//   PLAYWRIGHT_BASE_URL=http://localhost:3001 pnpm test:e2e

test.describe('Cache Lab (Cache Components)', () => {
  test('use cache non-deterministic values are stable until updateTag', async ({
    page,
  }) => {
    await page.goto('/cache-lab/use-cache-nondeterministic');

    const random1 = page.getByTestId('random1');
    const now = page.getByTestId('now');

    await expect(random1).toBeVisible();

    const beforeRandom = await random1.textContent();
    const beforeNow = await now.textContent();

    await page.reload();
    await expect(random1).toBeVisible();

    const afterReloadRandom = await random1.textContent();
    const afterReloadNow = await now.textContent();

    expect(afterReloadRandom).toBe(beforeRandom);
    expect(afterReloadNow).toBe(beforeNow);

    await page
      .getByRole('button', { name: "updateTag('cache-lab:nondet')" })
      .click();
    await page.waitForLoadState('networkidle');

    await expect(random1).toBeVisible();

    const afterInvalidateRandom = await random1.textContent();
    const afterInvalidateNow = await now.textContent();

    expect(afterInvalidateRandom).not.toBe(beforeRandom);
    expect(afterInvalidateNow).not.toBe(beforeNow);
  });

  test('tag invalidation changes cached values (updateTag + revalidateTag)', async ({
    page,
  }) => {
    await page.goto('/cache-lab/tag-invalidation');

    const createdAt = page.getByTestId('createdAt');
    const value = page.getByTestId('value');

    await expect(createdAt).toBeVisible();

    const beforeCreatedAt = await createdAt.textContent();
    const beforeValue = await value.textContent();

    await page.reload();
    await expect(createdAt).toBeVisible();
    expect(await createdAt.textContent()).toBe(beforeCreatedAt);
    expect(await value.textContent()).toBe(beforeValue);

    await page
      .getByRole('button', { name: "updateTag('cache-lab:tag')" })
      .click();
    await page.waitForLoadState('networkidle');

    await expect(createdAt).toBeVisible();
    expect(await createdAt.textContent()).not.toBe(beforeCreatedAt);
    expect(await value.textContent()).not.toBe(beforeValue);

    const afterUpdateCreatedAt = await createdAt.textContent();
    const afterUpdateValue = await value.textContent();

    await page
      .getByRole('button', { name: "revalidateTag('cache-lab:tag')" })
      .click();
    await page.waitForLoadState('networkidle');

    await expect(createdAt).toBeVisible();

    const maybeStaleCreatedAt = await createdAt.textContent();
    const maybeStaleValue = await value.textContent();

    // Revalidate can be SWR; allow either immediate refresh or stale served,
    // but the value should eventually change on subsequent reloads.
    if (maybeStaleCreatedAt === afterUpdateCreatedAt) {
      // give background refresh some time
      await page.waitForTimeout(4000);
      await page.reload();
      await expect(createdAt).toBeVisible();
    }

    expect(await createdAt.textContent()).not.toBe(afterUpdateCreatedAt);
    expect(await value.textContent()).not.toBe(afterUpdateValue);
  });

  test('runtime cookie changes cache key (cached payload differs per cookie)', async ({
    page,
  }) => {
    await page.goto('/cache-lab/runtime-data-suspense');

    const cookieValue = page.getByTestId('cookie');
    const payload = page.getByTestId('payload');

    await expect(cookieValue).toBeVisible();

    await page.getByRole('button', { name: 'Set cookie: user-a' }).click();
    await page.waitForLoadState('networkidle');

    await expect(cookieValue).toHaveText('user-a');
    const payloadA1 = await payload.textContent();

    await page.reload();
    await expect(cookieValue).toHaveText('user-a');
    const payloadA2 = await payload.textContent();
    expect(payloadA2).toBe(payloadA1);

    await page.getByRole('button', { name: 'Set cookie: user-b' }).click();
    await page.waitForLoadState('networkidle');

    await expect(cookieValue).toHaveText('user-b');
    const payloadB = await payload.textContent();

    expect(payloadB).not.toBe(payloadA1);
  });

  test('stale-while-revalidate demo eventually produces a new value after revalidateTag', async ({
    page,
  }) => {
    await page.goto('/cache-lab/stale-while-revalidate');

    const computedAt = page.getByTestId('computedAt');
    const value = page.getByTestId('value');

    await expect(computedAt).toBeVisible();

    const beforeComputedAt = await computedAt.textContent();
    const beforeValue = await value.textContent();

    // Ensure it becomes stale.
    await page.waitForTimeout(3000);

    await page
      .getByRole('button', { name: "revalidateTag('cache-lab:swr')" })
      .click();
    await page.waitForLoadState('networkidle');

    // Allow some time for background refresh to potentially complete.
    await page.waitForTimeout(4500);

    await page.reload();
    await expect(computedAt).toBeVisible();

    expect(await computedAt.textContent()).not.toBe(beforeComputedAt);
    expect(await value.textContent()).not.toBe(beforeValue);
  });
});
