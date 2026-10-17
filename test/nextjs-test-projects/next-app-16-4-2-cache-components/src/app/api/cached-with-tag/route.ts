import { NextResponse } from 'next/server';
import { cacheTag } from 'next/cache';

let counter = 0;

export async function GET() {
  const data = await getCachedData();
  return NextResponse.json(data);
}

async function getCachedData() {
  'use cache';
  cacheTag('test-tag');

  counter++;
  return {
    counter,
    timestamp: Date.now(),
    message: 'This data should be cached',
  };
}
