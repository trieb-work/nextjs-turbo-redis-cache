import { NextResponse } from 'next/server';

let counter = 0;

export async function GET() {
  const data = await getCachedData();
  return NextResponse.json(data);
}

async function getCachedData() {
  'use cache';

  counter++;
  return {
    counter,
    timestamp: Date.now(),
    message: 'Revalidated cached data',
  };
}
