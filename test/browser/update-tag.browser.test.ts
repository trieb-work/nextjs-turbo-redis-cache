import { test, expect } from 'vitest';

// Base URL of the running Next 16 app.
// Start it separately, e.g.:
//   cd test/integration/next-app-16-0-3 && pnpm dev
// and ensure it listens on the same origin as below.
const BASE_URL =
  (globalThis as any).NEXT_BROWSER_BASE_URL || 'http://localhost:3000';

// This test exercises a real Server Action that calls updateTag.
// It does not assert Redis state, but it verifies that calling the
// server action endpoint does not trigger the "Server Action only" error.

test('Server Action calling updateTag responds without server-action-only error', async () => {
  // 1) Fetch the SSR HTML for the page containing the Server Action form
  const res = await fetch(`${BASE_URL}/update-tag-test`);
  expect(res.status).toBeLessThan(500);
  const html = await res.text();

  // 2) Parse the HTML to find the form action URL that Next generated
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const form = doc.querySelector('form');
  expect(form).not.toBeNull();

  const actionAttr = form!.getAttribute('action');
  expect(actionAttr).toBeTruthy();

  const actionUrl = new URL(actionAttr!, BASE_URL).toString();

  // 3) Call the Server Action endpoint directly.
  //    If updateTag were not allowed here, Next.js would respond with
  //    an error page that contains the specific error message.
  const actionRes = await fetch(actionUrl, { method: 'POST' });
  const actionText = await actionRes.text();

  expect(actionRes.status).toBeLessThan(500);
  expect(actionText).not.toContain(
    'updateTag can only be called from within a Server Action',
  );
});
