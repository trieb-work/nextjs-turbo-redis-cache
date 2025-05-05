export const dynamic = 'force-dynamic';

export default async function TestPage() {
  const res = await fetch('http://localhost:3000/api/cached-static-fetch');
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
