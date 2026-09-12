import Link from 'next/link';
import { Suspense } from 'react';
import { cacheTag, updateTag } from 'next/cache';

async function getRemoteCachedValue() {
  'use cache: remote';

  cacheTag('cache-lab:remote');

  return {
    value: Math.random(),
    computedAt: Date.now(),
  };
}

async function triggerUpdateTag() {
  'use server';
  updateTag('cache-lab:remote');
}

async function RemotePanel() {
  const data = await getRemoteCachedValue();

  return (
    <div className="rounded-lg border p-5">
      <div className="text-sm text-slate-700">
        <div>
          <span className="font-medium">computedAt:</span>{' '}
          <span data-testid="computedAt" className="font-mono">
            {data.computedAt}
          </span>
        </div>
        <div className="mt-1">
          <span className="font-medium">value:</span>{' '}
          <span data-testid="value" className="font-mono">
            {data.value}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function UseCacheRemotePage() {
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
        <h1 className="text-2xl font-semibold">use cache: remote</h1>
        <p className="mt-2 text-sm text-slate-600">
          Exercises the <code>cacheHandlers.remote</code> handler backed by
          Redis. Values should stay stable across reloads until{' '}
          <code>updateTag</code> runs.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
            Loading remote cached content…
          </div>
        }
      >
        <RemotePanel />
      </Suspense>

      <form action={triggerUpdateTag} className="mt-6">
        <button
          className="rounded-md border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
          type="submit"
        >
          updateTag(&apos;cache-lab:remote&apos;)
        </button>
      </form>
    </main>
  );
}
