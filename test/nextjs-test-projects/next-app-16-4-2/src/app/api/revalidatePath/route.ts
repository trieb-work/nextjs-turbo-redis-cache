import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path');
  if (!path) {
    return NextResponse.json(
      { error: 'Missing path parameter' },
      { status: 400 },
    );
  }
  revalidatePath(path);
  return NextResponse.json({ success: true });
}
