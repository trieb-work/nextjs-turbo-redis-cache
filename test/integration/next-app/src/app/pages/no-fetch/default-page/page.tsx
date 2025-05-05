export default async function TestPage() {
  await new Promise((r) => setTimeout(r, 1000));
  const rdm = Math.random();
  return (
    <main
      style={{ padding: 32, fontFamily: 'sans-serif', textAlign: 'center' }}
    >
      <h1>Test Page</h1>
      <p>Random number: {rdm}</p>
      <p>This is a test page for integration testing.</p>
      <p>Timestamp: {Date.now()}</p>
      <p>Slug: /test-page</p>
    </main>
  );
}

/**
 * TODO
 * Test cases:
 * 0. Store timestamp of the first call in a variable so we can later check if TTL in redis is correct
 * 1. Call the page twice
 * 2. Extract the Timestamp from both results
 * 3. Compare the two timestamps
 * 4. The timestamps should be the same, meaning that the page was deduplicated
 *
 * 5. Connect to redis and check if the page was cached in redis and if TTL is set correctly
 *
 * 6. Call the page again, but wait 3 seconds before calling it
 * 7. Extract the Timestamp
 * 8. Compare the timestamp to previous timestamp
 * 9. The timestamp should be the same, meaning that the page was cached (By in-memory cache which is set to 10 seconds by default)
 *
 * 10. Call the page again, but wait 11 seconds before calling it
 * 11. Extract the Timestamp
 * 12. Compare the timestamp to previous timestamp
 * 13. The timestamp should be the same, meaning that the page was cached (By redis cache which becomes active after in-memory cache expires)
 *
 * 14. Connect to redis and check if the page was cached in redis and if TTL is set correctly
 *
 * 15. Check expiration time of the page in redis
 *
 * 16. Call the page again after TTL expiration time
 * 17. Extract the Timestamp
 * 18. Compare the timestamp to previous timestamp
 * 19. The timestamp should be different, meaning that the page was recreated
 *
 * 20. call API which will invalidate the page via a revalidatePage action
 * 21. Call the page again
 * 18. Compare the timestamp to previous timestamp
 * 19. The timestamp should be different, meaning that the page was recreated
 *
 * 20. Connect to redis and delete the page from redis
 * 21. Call the page again, but wait 11 seconds before calling it
 * 22. Compare the timestamp to previous timestamp
 * 23. The timestamp should be different, meaning that the page was recreated
 */
