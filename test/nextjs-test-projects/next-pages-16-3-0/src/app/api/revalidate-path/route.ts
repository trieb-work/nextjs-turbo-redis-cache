import { revalidatePath } from 'next/cache';
import type { NextRequest } from 'next/server';

// revalidatePath() needs an App Router request scope, so it cannot be called
// from a Pages API route. Next.js turns the call into
// revalidateTag('_N_T_<path>') on the cache handler, which must find the
// Pages Router entry through its implicit path tag.
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) {
    return Response.json(
      { revalidated: false, error: 'Missing ?path= query parameter' },
      { status: 400 },
    );
  }
  revalidatePath(path);
  return Response.json({ revalidated: true, path });
}
