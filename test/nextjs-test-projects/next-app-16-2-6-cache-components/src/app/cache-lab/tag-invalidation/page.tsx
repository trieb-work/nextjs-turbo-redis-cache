import Link from 'next/link';
import { cacheTag, updateTag, revalidateTag, cacheLife } from 'next/cache';
import { Suspense } from 'react';

async function getTaggedData() {
  'use cache';

  cacheLife({ stale: 5, revalidate: 10, expire: 60 });
  cacheTag('cache-lab:tag');

  return {
    value: Math.random(),
    createdAt: Date.now(),
  };
}

async function doUpdateTag() {
  'use server';
  updateTag('cache-lab:tag');
}

async function doRevalidateTag() {
  'use server';
  revalidateTag('cache-lab:tag', { expire: 1 });
}

async function CachedTaggedPanel() {
  const data = await getTaggedData();
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
          <dt className="font-medium">value</dt>
          <dd data-testid="value" className="font-mono text-slate-700">
            {data.value}
          </dd>
        </div>
        <div>
          <dt className="font-medium">cacheLife</dt>
          <dd className="font-mono text-slate-700">
            {'{ stale: 5, revalidate: 10, expire: 60 }'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function TagInvalidationPage() {
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
        <h1 className="text-2xl font-semibold">
          Tags: updateTag vs revalidateTag
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          This page caches a function tagged with{' '}
          <code>cacheTag('cache-lab:tag')</code>. Use the buttons to invalidate.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
            Loading cached tagged content…
          </div>
        }
      >
        <CachedTaggedPanel />
      </Suspense>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <form action={doUpdateTag}>
          <button
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            type="submit"
          >
            updateTag('cache-lab:tag')
          </button>
        </form>

        <form action={doRevalidateTag}>
          <button
            className="w-full rounded-md border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
            type="submit"
          >
            revalidateTag('cache-lab:tag')
          </button>
        </form>
      </div>

      <div className="mt-6 rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
        <div className="space-y-2">
          <p>Expected: values should stay stable on reloads.</p>
          <p>
            <strong>updateTag</strong> is intended for “expire + immediately
            refresh within the same request” (used after mutations in Server
            Actions).
          </p>
          <p>
            <strong>revalidateTag</strong> invalidates tagged entries with
            stale-while-revalidate behavior.
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
