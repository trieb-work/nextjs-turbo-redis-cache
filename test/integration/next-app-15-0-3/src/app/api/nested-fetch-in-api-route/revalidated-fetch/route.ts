import { NextResponse } from 'next/server';

let counter = 0;

export const dynamic = 'force-dynamic';

export async function GET() {
  counter++;
  const res = await fetch(
    `http://localhost:${process.env.NEXT_START_PORT || 3000}/api/uncached-fetch`,
    {
      next: {
        revalidate: 3,
        tags: ['revalidated-fetch-revalidate3-nested-fetch-in-api-route'],
      },
    },
  );
  const data = await res.json();
  return NextResponse.json(
    { counter, subFetchData: data },
    {
      headers: {
        'Cache-Control': 'public, max-age=1',
      },
    },
  );
}
