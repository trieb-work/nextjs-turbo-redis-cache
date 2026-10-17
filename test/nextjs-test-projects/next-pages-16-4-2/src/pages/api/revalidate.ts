import type { NextApiRequest, NextApiResponse } from 'next';

// On-demand revalidation endpoint: res.revalidate(path) re-renders the page
// and writes the fresh entry through the cache handler, so all instances
// sharing the same Redis pick it up.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const path = req.query.path;
  if (typeof path !== 'string') {
    return res
      .status(400)
      .json({ revalidated: false, error: 'Missing ?path= query parameter' });
  }
  try {
    await res.revalidate(path);
    return res.json({ revalidated: true, path });
  } catch (err) {
    return res
      .status(500)
      .json({ revalidated: false, path, error: String(err) });
  }
}
