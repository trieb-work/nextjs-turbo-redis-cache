'use server';

export type PurgeResult = {
  ok: boolean;
  method: string;
  target: string;
  cfResponse?: unknown;
  error?: string;
};

const CF_ZONE_ID = process.env.CF_ZONE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_HOSTNAME = process.env.CF_TUNNEL_HOSTNAME;

function cfHeaders() {
  return {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function purgeByPrefix(prefix: string): Promise<PurgeResult> {
  if (!CF_ZONE_ID || !CF_API_TOKEN || !CF_HOSTNAME) {
    return {
      ok: false,
      method: 'prefix',
      target: prefix,
      error: 'CF_ZONE_ID, CF_API_TOKEN or CF_TUNNEL_HOSTNAME not set',
    };
  }
  const target = `${CF_HOSTNAME}${prefix}`;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: cfHeaders(),
        body: JSON.stringify({ prefixes: [target] }),
      },
    );
    const json = await res.json();
    return {
      ok: (json as { success: boolean }).success === true,
      method: 'prefix',
      target,
      cfResponse: json,
    };
  } catch (e) {
    return { ok: false, method: 'prefix', target, error: String(e) };
  }
}

export async function purgeByUrl(url: string): Promise<PurgeResult> {
  if (!CF_ZONE_ID || !CF_API_TOKEN || !CF_HOSTNAME) {
    return {
      ok: false,
      method: 'url',
      target: url,
      error: 'CF_ZONE_ID, CF_API_TOKEN or CF_TUNNEL_HOSTNAME not set',
    };
  }
  const target = url.startsWith('http') ? url : `https://${CF_HOSTNAME}${url}`;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: cfHeaders(),
        body: JSON.stringify({ files: [target] }),
      },
    );
    const json = await res.json();
    return {
      ok: (json as { success: boolean }).success === true,
      method: 'url',
      target,
      cfResponse: json,
    };
  } catch (e) {
    return { ok: false, method: 'url', target, error: String(e) };
  }
}

export async function purgeEverything(): Promise<PurgeResult> {
  if (!CF_ZONE_ID || !CF_API_TOKEN) {
    return {
      ok: false,
      method: 'everything',
      target: '*',
      error: 'CF_ZONE_ID or CF_API_TOKEN not set',
    };
  }
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: cfHeaders(),
        body: JSON.stringify({ purge_everything: true }),
      },
    );
    const json = await res.json();
    return {
      ok: (json as { success: boolean }).success === true,
      method: 'everything',
      target: '*',
      cfResponse: json,
    };
  } catch (e) {
    return { ok: false, method: 'everything', target: '*', error: String(e) };
  }
}
