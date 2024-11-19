# nextjs-turbo-redis-cache

The ultimate Redis caching solution for Next.js. Built for production-ready, large-scale projects, it delivers unparalleled performance and efficiency with features tailored for high-traffic applications.

Key Features:

- _Turbocharged Storage_: Avoids base64 encoding to save ~33% of storage space compared to traditional implementations.
- _Batch Tag Invalidation_: Groups and optimizes delete operations for minimal Redis stress.
- _Request Deduplication_: Prevents redundant Redis get calls, ensuring faster response times.
- _In-Memory Caching_: Includes local caching for Redis get operations to reduce latency further.
- _Efficient Tag Management_: in-memory tags map for lightning-fast revalidate operations with minimal Redis overhead.
- _Intelligent Key-Space Notifications_: Automatic update of in-memory tags map for expired or evicted keys.

## Getting started

TODO

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
