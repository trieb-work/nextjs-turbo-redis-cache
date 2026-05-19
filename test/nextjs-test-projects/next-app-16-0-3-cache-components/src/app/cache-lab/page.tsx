import Link from 'next/link';

export default function CacheLabIndexPage() {
  return (
    <main className="mx-auto max-w-5xl p-10">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold">Cache Lab</h1>
        <p className="mt-2 text-slate-600">
          Manual test pages for Next.js Cache Components (use cache, cacheLife,
          tags, updateTag/revalidateTag, and Suspense boundaries).
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Link
          className="rounded-lg border p-5 hover:bg-slate-50"
          href="/cache-lab/use-cache-nondeterministic"
        >
          <h2 className="text-lg font-medium">use cache: non-deterministic</h2>
          <p className="mt-1 text-sm text-slate-600">
            Random/Date/UUID should stay identical across reloads until you
            invalidate.
          </p>
        </Link>

        <Link
          className="rounded-lg border p-5 hover:bg-slate-50"
          href="/cache-lab/cachelife-short"
        >
          <h2 className="text-lg font-medium">cacheLife: short timings</h2>
          <p className="mt-1 text-sm text-slate-600">
            Uses very small stale/revalidate/expire values so you can observe
            SWR + expiry quickly.
          </p>
        </Link>

        <Link
          className="rounded-lg border p-5 hover:bg-slate-50"
          href="/cache-lab/tag-invalidation"
        >
          <h2 className="text-lg font-medium">
            Tags: updateTag vs revalidateTag
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Cached component tagged via cacheTag. Trigger updateTag (immediate)
            or revalidateTag (SWR).
          </p>
        </Link>

        <Link
          className="rounded-lg border p-5 hover:bg-slate-50"
          href="/cache-lab/stale-while-revalidate"
        >
          <h2 className="text-lg font-medium">
            SWR: stale-while-revalidate (slow)
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Forces slow recomputation so you can see whether stale is served
            immediately while refresh happens in the background.
          </p>
        </Link>

        <Link
          className="rounded-lg border p-5 hover:bg-slate-50"
          href="/cache-lab/runtime-data-suspense"
        >
          <h2 className="text-lg font-medium">Runtime data + Suspense</h2>
          <p className="mt-1 text-sm text-slate-600">
            Reads cookies() at request time in a non-cached component and passes
            it into a cached component to show correct boundaries.
          </p>
        </Link>
      </section>

      <section className="mt-12 rounded-lg border bg-slate-50 p-5">
        <h3 className="font-medium">How to use</h3>
        <div className="mt-2 space-y-2 text-sm text-slate-700">
          <p>
            Open each page in 2 tabs and compare behavior while reloading.
            Observe which values stay stable, and which update.
          </p>
          <p>
            Use the buttons on each page to trigger tag invalidation and observe
            how quickly new content becomes visible.
          </p>
        </div>
      </section>
    </main>
  );
}
