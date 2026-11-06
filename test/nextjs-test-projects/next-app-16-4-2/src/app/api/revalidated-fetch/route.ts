import { NextResponse } from 'next/server';

let counter = 0;

export const revalidate = 5;

export async function GET() {
  counter++;
  return NextResponse.json(
    { counter },
    {
      headers: {
        'Cache-Control': 'public, max-age=1',
      },
    },
  );
}
