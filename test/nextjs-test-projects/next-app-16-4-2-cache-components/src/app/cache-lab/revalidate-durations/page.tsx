import Link from 'next/link';
import { Suspense } from 'react';
import { cacheLife, cacheTag, revalidateTag } from 'next/cache';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSlowTaggedValue() {
  'use cache';

  cacheLife({ stale: 60, revalidate: 120, expire: 300 });
  cacheTag('cache-lab:durations');

  await sleep(2500);

  return {
    computedAt: Date.now(),
    value: Math.random(),
  };
}

async function triggerDeferredRevalidateTag() {
  'use server';
  revalidateTag('cache-lab:durations', { expire: 2 });
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
      </div>
    </div>
  );
}

export default function RevalidateDurationsPage() {
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
          revalidateTag durations (SWR stale window)
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Calls <code>revalidateTag(tag, {'{ expire: 2 }'})</code>. The handler
          should mark the tag stale immediately while keeping the Redis entry so
          the next request can serve stale content (SWR) during refresh.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
            Loading cached content… (first load can take ~2.5s)
          </div>
        }
      >
        <CachedPanel />
      </Suspense>

      <form action={triggerDeferredRevalidateTag} className="mt-6">
        <button
          className="rounded-md border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
          type="submit"
        >
          revalidateTag(&apos;cache-lab:durations&apos;, {'{ expire: 2 }'})
        </button>
      </form>

      <div className="mt-6 rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
        <p className="font-medium">How to observe SWR invalidation</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Load once (expect ~2.5s).</li>
          <li>Click the button, then reload immediately.</li>
          <li>
            The reload should still show the old values (fast SWR). After
            background refresh (~2.5s), values should change.
          </li>
        </ol>
      </div>
    </main>
  );
}
