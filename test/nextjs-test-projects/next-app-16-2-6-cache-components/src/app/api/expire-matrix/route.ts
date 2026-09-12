import { NextResponse } from 'next/server';
import { cacheLife, cacheTag } from 'next/cache';

let counter = 0;

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') || 'default';
  const data = await getExpireMatrixData(id);
  return NextResponse.json({ ...data, id });
}

async function getExpireMatrixData(id: string) {
  'use cache';
  // Long time-based lifetime so only tag invalidation can change the value.
  cacheLife({ stale: 300, revalidate: 3600, expire: 86_400 });
  cacheTag(`expire-matrix-${id}`);

  counter += 1;
  return {
    counter,
    timestamp: Date.now(),
  };
}
