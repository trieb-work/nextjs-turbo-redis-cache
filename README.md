# nextjs-turbo-redis-cache

The ultimate Redis caching solution for Next.js. Built for production-ready, large-scale projects, it delivers unparalleled performance and efficiency with features tailored for high-traffic applications.

Key Features:

- _Turbocharged Storage_: Avoids base64 encoding to save ~33% of storage space compared to traditional implementations.
- _Batch Tag Invalidation_: Groups and optimizes delete operations for minimal Redis stress.
- _Request Deduplication_: Prevents redundant Redis get calls, ensuring faster response times.
- _In-Memory Caching_: Includes local caching for Redis get operations to reduce latency further.
- _Efficient Tag Management_: in-memory tags map for lightning-fast revalidate operations with minimal Redis overhead.
- _Intelligent Key-Space Notifications_: Automatic update of in-memory tags map for expired or evicted keys.

## Describe Options

TODO

## Getting started

```bash
pnpm install @trieb.work/nextjs-turbo-redis-cache
```

extend `next.config.js` with:
```
const nextConfig = {
  ...
  cacheHandler: require.resolve("@trieb.work/nextjs-turbo-redis-cache")
  ...
}
```

## Consistency

To understand consistency levels of this caching implementation we first have to understand the consistency of redis itself:
Redis executes commands in a single-threaded manner. This ensures that all operations are processed sequentially, so clients always see a consistent view of the data.
But depending on the setup of redis this can change:

- Strong consistency: only for single node setup
- Eventual consistency: In a master-replica setup (strong consistency only while there is no failover)
- Eventual consistency: In Redis Cluster mode

Consistency levels of Caching Handler:
If Redis is used in a single node setup and Request Deduplication is turned off, only then the caching handler will have strong consistency.

If using Request Deduplication, the strong consistency is not guaranteed anymore. The following sequence can happen with request deduplication:
Instance 1: call set A 1
Instance 1: served set A 1
Instance 2: call get A
Instance 1: call delete A
Instance 2: call get A
Instance 2: served get A -> 1
Instance 2: served get A -> 1 (served 1 but should already be deleted)
Instance 1: served delete A

The time window for this eventual consistency to occur is typically around the length of a single redis command. Depending on your load ranging from 5ms to max 100ms.
If using local in-memory caching (Enabled by RedisStringsHandler option inMemoryCachingTime), the window for this eventual consistency to occur can be even higher because additionally also synchronization messages have to get delivered. Depending on your load typically ranging around 50ms to max of 120ms.

Since all caching calls in one api/page/server action request is always served by the same instance this problem will not occur inside a single request but rather in a combination of multiple parallel requests. The probability that this will occur for a single user during a request sequence is very low, since typically a single user will not make the follow up request during this small time window of typically 50ms. To further mitigate the Problem and increase performance (increase local in-memory cache hit ratio) make sure that your load balancer will always serve one user to the same instance (sticky sessions).

## Development

5. Run `npm install` to install the dependencies
6. Run `npm run build` to build the project
7. Run `npm run dev` to develop the project
8. Run `npm run test` to test the project
9. Checkout into a new branch (main is protected)
10. Change code and commit it using conventional commit. Staged code will get checked
11. Push and create a PR (against main or beta) to run CI
12. Merge to main or beta to create a release or pre-release

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.


## Sponsor

This project is created and maintained by the Next.js & Payload CMS agency [trieb.work](https://trieb.work)

