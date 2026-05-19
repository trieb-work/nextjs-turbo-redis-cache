import { NextResponse } from 'next/server';
import { cacheLife, cacheTag } from 'next/cache';

let counter = 0;

export async function GET() {
  const data = await getCachedDataWithLife();
  return NextResponse.json(data);
}

async function getCachedDataWithLife() {
  'use cache';

  cacheLife({ stale: 1, revalidate: 2, expire: 5 });
  cacheTag('cache-life-test');

  counter++;

  return {
    counter,
    timestamp: Date.now(),
    profile: { stale: 1, revalidate: 2, expire: 5 },
  };
}
