export default async function TestPage() {
  let res;
  try {
    res = await fetch(
      `http://localhost:${process.env.NEXT_START_PORT || 3000}/api/cached-static-fetch`,
      {
        next: {
          revalidate: 15,
          tags: ['cached-static-fetch-revalidate15-default-page'],
        },
      },
    );
  } catch (e) {
    // ECONNREFUSED is expected during build
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (((e as Error).cause as any)?.code !== 'ECONNREFUSED') {
      throw e;
    }
  }

  const data = res?.ok ? await res.json() : { counter: -1 };

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
