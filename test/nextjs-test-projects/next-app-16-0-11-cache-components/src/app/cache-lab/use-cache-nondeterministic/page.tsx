import Link from 'next/link';
import { cacheTag, updateTag } from 'next/cache';

async function getCachedNonDeterministicValues() {
  'use cache';

  cacheTag('cache-lab:nondet');

  const random1 = Math.random();
  const random2 = Math.random();
  const now = Date.now();
  const uuid = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(8));

  return {
    random1,
    random2,
    now,
    uuid,
    bytes: Array.from(bytes),
  };
}

async function refresh() {
  'use server';
  updateTag('cache-lab:nondet');
}

export default async function UseCacheNonDeterministicPage() {
  const data = await getCachedNonDeterministicValues();

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
        <h1 className="text-2xl font-semibold">use cache: non-deterministic</h1>
        <p className="mt-2 text-sm text-slate-600">
          Per docs, non-deterministic operations inside a <code>use cache</code>{' '}
          scope run once and then stay stable for all requests until you
          invalidate.
        </p>
      </header>

      <form action={refresh} className="mb-6">
        <button
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          type="submit"
        >
          updateTag('cache-lab:nondet')
        </button>
      </form>

      <div className="rounded-lg border p-5">
        <dl className="grid grid-cols-1 gap-3 text-sm">
          <div>
            <dt className="font-medium">random1</dt>
            <dd data-testid="random1" className="font-mono text-slate-700">
              {data.random1}
            </dd>
          </div>
          <div>
            <dt className="font-medium">random2</dt>
            <dd data-testid="random2" className="font-mono text-slate-700">
              {data.random2}
            </dd>
          </div>
          <div>
            <dt className="font-medium">now (Date.now)</dt>
            <dd data-testid="now" className="font-mono text-slate-700">
              {data.now}
            </dd>
          </div>
          <div>
            <dt className="font-medium">uuid</dt>
            <dd data-testid="uuid" className="font-mono text-slate-700">
              {data.uuid}
            </dd>
          </div>
          <div>
            <dt className="font-medium">bytes</dt>
            <dd data-testid="bytes" className="font-mono text-slate-700">
              {JSON.stringify(data.bytes)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
        <div className="space-y-2">
          <p>
            Expected: Reloading the page should keep values identical across
            requests.
          </p>
          <p>
            Click the button (Server Action) to run <code>updateTag</code> and
            refresh the cached entry.
          </p>
        </div>
      </div>
    </main>
  );
}
