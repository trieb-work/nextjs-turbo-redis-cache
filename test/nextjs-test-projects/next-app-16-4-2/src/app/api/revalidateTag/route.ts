import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get('tag');
  if (!tag) {
    return NextResponse.json(
      { error: 'Missing tag parameter' },
      { status: 400 },
    );
  }
  const profile = searchParams.get('profile');
  if (profile === 'expire') {
    revalidateTag(tag, { expire: 60 });
  } else {
    revalidateTag(tag, 'max');
  }
  return NextResponse.json({ success: true });
}
