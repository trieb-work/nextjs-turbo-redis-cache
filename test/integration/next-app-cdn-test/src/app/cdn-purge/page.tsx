'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { purgeByPrefix, purgeByUrl, purgeEverything } from './actions';
import type { PurgeResult } from './actions';

const PRESET_PREFIXES = [
  { label: '/cache-lab (all)', value: '/cache-lab' },
  {
    label: '/cache-lab/tag-invalidation',
    value: '/cache-lab/tag-invalidation',
  },
  { label: '/cache-lab/cachelife-short', value: '/cache-lab/cachelife-short' },
  {
    label: '/cache-lab/stale-while-revalidate',
    value: '/cache-lab/stale-while-revalidate',
  },
  {
    label: '/cache-lab/use-cache-nondeterministic',
    value: '/cache-lab/use-cache-nondeterministic',
  },
];

const PRESET_URLS = [
  '/cache-lab',
  '/cache-lab/tag-invalidation',
  '/cache-lab/cachelife-short',
  '/cache-lab/stale-while-revalidate',
  '/cache-lab/use-cache-nondeterministic',
];

function ResultBadge({ result }: { result: PurgeResult }) {
  return (
    <div
      className={`mt-3 rounded-lg border p-4 text-sm ${
        result.ok
          ? 'border-green-200 bg-green-50 text-green-800'
          : 'border-red-200 bg-red-50 text-red-800'
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        <span>{result.ok ? '✓ Purge successful' : '✗ Purge failed'}</span>
        <span className="rounded bg-white/60 px-1.5 py-0.5 text-xs font-mono">
          {result.method}
        </span>
      </div>
      <div className="mt-1 font-mono text-xs break-all">
        target: {result.target}
      </div>
      {result.error && (
        <div className="mt-1 text-xs">error: {result.error}</div>
      )}
      {result.cfResponse !== undefined && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs opacity-70">
            CF response
          </summary>
          <pre className="mt-1 overflow-x-auto text-xs">
            {JSON.stringify(
              result.cfResponse as Record<string, unknown>,
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function CdnPurgePage() {
  const [result, setResult] = useState<PurgeResult | null>(null);
  const [customPrefix, setCustomPrefix] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<PurgeResult>) {
    setResult(null);
    startTransition(async () => {
      const r = await action();
      setResult(r);
    });
  }

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

      <header className="mb-8">
        <h1 className="text-2xl font-semibold">CDN Cache Purge</h1>
        <p className="mt-2 text-sm text-slate-600">
          Trigger Cloudflare cache purge operations. After purging, reload the
          target page and check <code>CF-Cache-Status</code> — it should flip
          back to <code>MISS</code>.
        </p>
      </header>

      {result && <ResultBadge result={result} />}

      {/* Prefix purge */}
      <section className="mt-8 rounded-lg border p-5">
        <h2 className="font-medium">Purge by Prefix</h2>
        <p className="mt-1 text-sm text-slate-500">
          Invalidates all cached URLs under a path prefix (up to 30 per call).
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {PRESET_PREFIXES.map(({ label, value }) => (
            <button
              key={value}
              disabled={isPending}
              onClick={() => run(() => purgeByPrefix(value))}
              className="rounded-md border bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            placeholder="/custom/path"
            value={customPrefix}
            onChange={(e) => setCustomPrefix(e.target.value)}
            className="flex-1 rounded-md border px-3 py-1.5 text-sm font-mono"
          />
          <button
            disabled={isPending || !customPrefix}
            onClick={() => run(() => purgeByPrefix(customPrefix))}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Purge prefix
          </button>
        </div>
      </section>

      {/* Single URL purge */}
      <section className="mt-6 rounded-lg border p-5">
        <h2 className="font-medium">Purge by URL</h2>
        <p className="mt-1 text-sm text-slate-500">
          Invalidates a single exact URL.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {PRESET_URLS.map((url) => (
            <button
              key={url}
              disabled={isPending}
              onClick={() => run(() => purgeByUrl(url))}
              className="rounded-md border bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {url}
            </button>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            placeholder="/cache-lab/tag-invalidation"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            className="flex-1 rounded-md border px-3 py-1.5 text-sm font-mono"
          />
          <button
            disabled={isPending || !customUrl}
            onClick={() => run(() => purgeByUrl(customUrl))}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Purge URL
          </button>
        </div>
      </section>

      {/* Purge everything */}
      <section className="mt-6 rounded-lg border border-red-200 p-5">
        <h2 className="font-medium text-red-700">Purge Everything</h2>
        <p className="mt-1 text-sm text-slate-500">
          Clears the entire zone cache. Use for a clean-slate test baseline.
        </p>
        <button
          disabled={isPending}
          onClick={() => run(() => purgeEverything())}
          className="mt-4 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          Purge entire zone cache
        </button>
      </section>

      {isPending && <div className="mt-4 text-sm text-slate-500">Purging…</div>}

      <div className="mt-8 rounded-lg border bg-slate-50 p-4 text-xs text-slate-500">
        <p className="font-medium">Workflow</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>Open a cache-lab page in another tab.</li>
          <li>
            Reload it twice — second request should be{' '}
            <code>CF-Cache-Status: HIT</code>.
          </li>
          <li>Click a purge button above.</li>
          <li>
            Reload the cache-lab page — should be <code>MISS</code> again.
          </li>
          <li>
            Reload once more — back to <code>HIT</code>.
          </li>
        </ol>
      </div>
    </main>
  );
}
