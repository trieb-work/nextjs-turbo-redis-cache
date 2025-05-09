export const dynamic = 'force-dynamic';

export default async function TestPage() {
  const res = await await fetch(
    `http://localhost:${process.env.NEXT_START_PORT || 3000}/api/revalidated-fetch`,
    {
      next: {
        revalidate: 15,
        tags: ['revalidated-fetch-revalidate15-force-dynamic-page'],
      },
    },
  );
  const data = await res.json();
  return (
    <main
      style={{ padding: 32, fontFamily: 'sans-serif', textAlign: 'center' }}
    >
      <h1>Test Page</h1>
      <p>Counter: {data.counter}</p>
      <p>This is a test page for integration testing.</p>
      <p>Timestamp: {Date.now()}</p>
      <p>Slug: /test-page</p>
    </main>
  );
}
