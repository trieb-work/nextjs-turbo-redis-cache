// This page will inherit the revalidate from it's subsequent fetch request
// meaning that the page will be revalidated after 15 seconds

export default async function TestPage() {
  try {
    const res = await fetch(
      `http://localhost:${process.env.NEXT_START_PORT || 3000}/api/revalidated-fetch`,
      {
        next: {
          revalidate: 15,
          tags: ['revalidated-fetch-revalidate15-default-page'],
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
  } catch (e) {
    return (
      <p>
        Error: {JSON.stringify(e)} (an error here is normal during build since
        API is not available yet)
      </p>
    );
  }
}
