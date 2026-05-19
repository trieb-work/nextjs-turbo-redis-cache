import Link from 'next/link';
import { Suspense } from 'react';
import { cacheLife, cacheTag, revalidateTag } from 'next/cache';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSlowTaggedValue() {
  'use cache';

  // Keep this short so you can observe SWR behavior quickly.
  // stale: after 2s the entry is considered stale
  // revalidate: after 8s Next may attempt to refresh
  // expire: after 60s it must be recomputed
  cacheLife({ stale: 2, revalidate: 8, expire: 60 });
  cacheTag('cache-lab:swr');

  // Make regeneration visibly expensive so you can tell whether the request was
  // served from stale cache (fast) or blocked on recomputation (slow).
  await sleep(3000);

  return {
    computedAt: Date.now(),
    value: Math.random(),
    note: 'This function always sleeps ~3s when it actually executes.',
  };
}

async function triggerRevalidateTag() {
  'use server';
  revalidateTag('cache-lab:swr', { expire: 1 });
}

async function CachedPanel() {
  const data = await getSlowTaggedValue();

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
        <div className="mt-1 text-xs text-slate-500">{data.note}</div>
      </div>
    </div>
  );
}

export default function StaleWhileRevalidatePage() {
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
          SWR: stale-while-revalidate (slow)
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          This page is designed to make stale-while-revalidate behavior visible.
          The cached function sleeps ~3 seconds whenever it really runs.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
            Loading cached content… (first time can take ~3s)
          </div>
        }
      >
        <CachedPanel />
      </Suspense>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <form action={triggerRevalidateTag}>
          <button
            className="w-full rounded-md border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
            type="submit"
          >
            revalidateTag('cache-lab:swr')
          </button>
        </form>
      </div>

      <div className="mt-6 rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
        <div className="space-y-2">
          <p className="font-medium">How to observe SWR (non-blocking)</p>
          <p>1) Load this page once (expect ~3s on the very first load).</p>
          <p>
            2) Wait ~3 seconds so the entry becomes <code>stale</code>{' '}
            (stale=2s).
          </p>
          <p>
            3) Click <code>revalidateTag</code>.
          </p>
          <p>4) Immediately reload the page:</p>
          <div className="rounded bg-white p-3 text-xs">
            If SWR is working, the reload should be fast and you may still see
            the old computedAt/value (stale served).
            <br />
            Reload again after ~3-4 seconds and you should see a new
            computedAt/value.
            <br />
            If SWR is not working, the reload will block for ~3 seconds.
          </div>
          <div className="text-xs text-slate-500">
            cacheLife: {'{ stale: 2, revalidate: 8, expire: 60 }'}
          </div>
        </div>
      </div>
    </main>
  );
}
