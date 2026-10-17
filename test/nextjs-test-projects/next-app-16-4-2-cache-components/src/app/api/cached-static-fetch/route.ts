import { NextResponse } from 'next/server';

let counter = 0;

export async function GET() {
  const data = await getSimpleCachedData();
  return NextResponse.json(data);
}

async function getSimpleCachedData() {
  'use cache';

  counter++;
  return {
    counter,
    timestamp: Date.now(),
    message: 'Simple cached data without tags',
  };
}
