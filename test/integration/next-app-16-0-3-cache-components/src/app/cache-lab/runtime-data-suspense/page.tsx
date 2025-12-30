import Link from 'next/link';
import { Suspense } from 'react';
import { cookies } from 'next/headers';

export default function RuntimeDataSuspensePage() {
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
        <h1 className="text-2xl font-semibold">Runtime data + Suspense</h1>
        <p className="mt-2 text-sm text-slate-600">
          This page reads <code>cookies()</code> at request time (runtime data),
          then passes a value into a cached function. The runtime read is
          wrapped in <code>{'<Suspense>'}</code> so it is an explicit dynamic
          boundary.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
            Loading runtime cookie…
          </div>
        }
      >
        <RuntimeCookieBlock />
      </Suspense>

      <div className="mt-6 rounded-lg border bg-slate-50 p-5 text-sm text-slate-700">
        <div className="space-y-2">
          <p>
            Expected: changing the cookie changes the <em>input</em> to the
            cached function, producing a different cache entry.
          </p>
          <p>
            The cached function itself uses <code>use cache</code>, so for the
            same cookie value, it should return a stable payload across reloads.
          </p>
        </div>
      </div>
    </main>
  );
}

async function setCookie(value: string) {
  'use server';
  const store = await cookies();
  store.set('cache_lab_session', value, { path: '/' });
}

async function setCookieUserA() {
  'use server';
  await setCookie('user-a');
}

async function setCookieUserB() {
  'use server';
  await setCookie('user-b');
}

async function RuntimeCookieBlock() {
  const store = await cookies();
  const sessionId = store.get('cache_lab_session')?.value || 'anonymous';

  return (
    <div className="rounded-lg border p-5">
      <div className="mb-4 text-sm">
        <div>
          <span className="font-medium">cookie cache_lab_session:</span>{' '}
          <span data-testid="cookie" className="font-mono text-slate-700">
            {sessionId}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <form action={setCookieUserA}>
          <button
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            type="submit"
          >
            Set cookie: user-a
          </button>
        </form>
        <form action={setCookieUserB}>
          <button
            className="w-full rounded-md border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
            type="submit"
          >
            Set cookie: user-b
          </button>
        </form>
      </div>

      <div className="mt-5">
        <CachedPerSession sessionId={sessionId} />
      </div>
    </div>
  );
}

async function CachedPerSession({ sessionId }: { sessionId: string }) {
  'use cache';

  const payload = {
    sessionId,
    createdAt: Date.now(),
    random: Math.random(),
  };

  return (
    <div className="rounded-md bg-slate-50 p-4 text-sm">
      <div className="font-medium">Cached payload (keyed by sessionId)</div>
      <pre data-testid="payload" className="mt-2 overflow-x-auto text-xs">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}
