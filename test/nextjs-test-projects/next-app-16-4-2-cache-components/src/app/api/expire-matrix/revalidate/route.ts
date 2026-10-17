import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

type Profile =
  | 'max'
  | 'default'
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days'
  | 'weeks'
  | { expire: number };

export async function POST(request: Request) {
  const body = (await request.json()) as {
    tag?: string;
    profile?: Profile | null;
  };
  const tag = body.tag || 'expire-matrix-default';

  if (body.profile === undefined || body.profile === null) {
    // Deprecated single-arg form: Next.js calls updateTags(tags) with no durations.
    (revalidateTag as (tag: string) => void)(tag);
  } else {
    revalidateTag(tag, body.profile);
  }

  return NextResponse.json({
    revalidated: true,
    tag,
    profile: body.profile ?? null,
    timestamp: Date.now(),
  });
}
