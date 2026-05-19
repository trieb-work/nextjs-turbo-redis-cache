import { updateTag } from 'next/cache';

export const dynamic = 'force-dynamic';

let clicks = 0;

async function increment() {
  'use server';

  // Simulate a mutation and call updateTag with a test tag
  clicks++;
  updateTag('update-tag-test');
}

export default function UpdateTagTestPage() {
  return (
    <main style={{ padding: 40, fontFamily: 'system-ui, sans-serif' }}>
      <h1>UpdateTag Test</h1>
      <form action={increment}>
        <p data-testid="clicks">Clicks: {clicks}</p>
        <button type="submit">Increment</button>
      </form>
    </main>
  );
}
