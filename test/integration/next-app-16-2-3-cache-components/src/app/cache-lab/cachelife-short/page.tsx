import Link from 'next/link';
import { cacheLife, cacheTag, revalidateTag } from 'next/cache';
import { Suspense } from 'react';

async function getCacheLifeSample() {
  'use cache';

  // Very short timings for manual testing.
  cacheLife({
    stale: 2,
    revalidate: 4,
    expire: 10,
  });

  cacheTag('cache-lab:cachelife-short');

  return {
    createdAt: Date.now(),
    random: Math.random(),
  };
}

async function triggerRevalidateTag() {
  'use server';
  revalidateTag('cache-lab:cachelife-short', { expire: 1 });
}

async function CachedDataPanel() {
  const data = await getCacheLifeSample();
  return (
    <div className="rounded-lg border p-5">
      <dl className="grid grid-cols-1 gap-3 text-sm">
        <div>
          <dt className="font-medium">createdAt</dt>
          <dd data-testid="createdAt" className="font-mono text-slate-700">
            {data.createdAt}
          </dd>
        </div>
        <div>
          <dt className="font-medium">random</dt>
          <dd data-testid="random" className="font-mono text-slate-700">
            {data.random}
          </dd>
        </div>
        <div>
          <dt className="font-medium">cacheLife config</dt>
          <dd className="font-mono text-slate-700">
            {'{ stale: 2, revalidate: 4, expire: 10 }'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function CacheLifeShortPage() {
  return (
    <main className="mx-auto max-w-3xl p-10">
      <div className="mb-6">
        <Link
          className="text-sm text-blue-600 hover:underline"
          href="/cache-lab"
        >
          ← Back to Cache Lab
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">cacheLife: short timings</h1>
        <p className="mt-2 text-sm text-slate-600">
          This uses <code>cacheLife</code> with short durations so you can
          observe stale / revalidate / expire behavior quickly.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
            Loading cached content…
          </div>
        }
      >
        <CachedDataPanel />
      </Suspense>

      <form action={triggerRevalidateTag} className="mt-6">
        <button
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          type="submit"
        >
          revalidateTag('cache-lab:cachelife-short')
        </button>
      </form>

      <div className="mt-6 rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
        <div className="space-y-2">
          <p>
            Expected: reload a few times. Within a couple seconds, the cached
            value may become stale; after revalidate, a fresh value should
            appear.
          </p>
          <p>
            This page deliberately puts the async work behind{' '}
            <code>{'<Suspense>'}</code> to avoid the "Blocking Route" warning.
          </p>
        </div>
      </div>
    </main>
  );
}
