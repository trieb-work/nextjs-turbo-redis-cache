import { headers } from 'next/headers';
import { connection } from 'next/server';
import { Suspense } from 'react';
import Link from 'next/link';

const CDN_HEADERS = [
  'cf-cache-status',
  'cf-ray',
  'cf-cache-control',
  'cdn-cache-control',
  'cache-control',
  'age',
  'x-cache-prefix',
  'x-vercel-cache',
  'surrogate-control',
];

async function HeadersTable() {
  await connection();
  const store = await headers();
  const all: Record<string, string> = {};
  store.forEach((value: string, key: string) => {
    all[key] = value;
  });

  const cdnHeaders = CDN_HEADERS.map((k) => ({
    key: k,
    value: all[k] ?? null,
  }));
  const otherHeaders = Object.entries(all).filter(
    ([k]) => !CDN_HEADERS.includes(k),
  );

  return (
    <>
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          CDN / Cache Headers
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-slate-400">
              <th className="pb-2 pr-4 font-medium">Header</th>
              <th className="pb-2 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {cdnHeaders.map(({ key, value }) => (
              <tr key={key} className="border-b last:border-0">
                <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                  {key}
                </td>
                <td className="py-2 font-mono text-xs">
                  {value ? (
                    <span
                      className={
                        key === 'cf-cache-status'
                          ? value === 'HIT'
                            ? 'rounded bg-green-100 px-1.5 py-0.5 text-green-800'
                            : value === 'MISS'
                              ? 'rounded bg-red-100 px-1.5 py-0.5 text-red-800'
                              : 'rounded bg-yellow-100 px-1.5 py-0.5 text-yellow-800'
                          : ''
                      }
                    >
                      {value}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          All Request Headers
        </h2>
        <div className="rounded-lg border bg-slate-50 p-4">
          <table className="w-full text-xs">
            <tbody>
              {otherHeaders.map(([key, value]) => (
                <tr key={key} className="border-b last:border-0">
                  <td className="py-1 pr-4 font-mono text-slate-400">{key}</td>
                  <td className="py-1 font-mono text-slate-600 break-all">
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function CdnStatusPage() {
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
        <h1 className="text-2xl font-semibold">CDN Status</h1>
        <p className="mt-2 text-sm text-slate-600">
          Request headers as seen by Next.js (forwarded by Cloudflare tunnel).
          Reload to observe <code>CF-Cache-Status</code> flipping from{' '}
          <code>MISS</code> → <code>HIT</code>.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          This page is always dynamic (not CDN-cached) — every request hits
          Next.js so you always see fresh headers.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="rounded-lg border bg-slate-50 p-5 text-sm text-slate-500">
            Loading headers…
          </div>
        }
      >
        <HeadersTable />
      </Suspense>
    </main>
  );
}
