export default function TestPage() {
  return (
    <main
      style={{ padding: 32, fontFamily: 'sans-serif', textAlign: 'center' }}
    >
      <h1>Test Page</h1>
      <p>This is a test page for integration testing.</p>
      <p>Timestamp: {Date.now()}</p>
      <p>Slug: /test-page</p>
    </main>
  );
}
