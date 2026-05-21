import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

export async function POST(request: Request) {
  const body = await request.json();
  const { tag } = body;

  if (!tag) {
    return NextResponse.json({ error: 'Tag is required' }, { status: 400 });
  }

  revalidateTag(tag, { expire: 1 });

  return NextResponse.json({
    revalidated: true,
    tag,
    timestamp: Date.now(),
  });
}
