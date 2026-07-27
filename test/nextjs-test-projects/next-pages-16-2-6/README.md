# next-pages-16-2-6

Next.js 16.2.6 **Pages Router** fixture for integration testing the Redis
cache handler with Pages Router cache entry kinds:

- `PAGES` — ISR pages via `getStaticProps` + `revalidate` and
  `getStaticPaths` with `fallback: 'blocking'` (`/isr/[slug]`)
- `REDIRECT` — `getStaticProps` returning `redirect:` (`/isr/redirect`)
- `null` value entries — `getStaticProps` returning `notFound: true`
  (`/isr/not-found`)
- `revalidate: false` TTL fallback (`/static-forever`)
- On-demand revalidation via `res.revalidate(path)`
  (`/api/revalidate?path=...`), used by the two-instance cross-server
  revalidation test

Used by `test/vitest/integration/pages-router.integration.test.ts`.
