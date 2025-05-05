export default async function TestPage() {
  try {
    const res = await fetch('http://localhost:3000/api/cached-static-fetch', {
      next: {
        revalidate: 15,
        tags: ['cached-static-fetch-revalidate15-default-page'],
      },
    });
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
  } catch (e) {
    return (
      <p>
        Error: {JSON.stringify(e)} (an error here is normal during build since
        API is not available yet)
      </p>
    );
  }
}
