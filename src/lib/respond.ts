/**
 * Every tool speaks the same shape.
 *
 * A refusal carries a stable machine-readable `reason`, a `message` written
 * for a person, and a `next` telling the agent what would actually work. The
 * interesting property of an agent-native interface is not that the site can
 * do things, it is that it can say precisely what it cannot do and why.
 */
export const ok = (body: Record<string, unknown>, maxAge = 0) =>
  new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });

export const refuse = (
  reason: string,
  message: string,
  next: string,
  extra: Record<string, unknown> = {},
  status = 200
) =>
  new Response(JSON.stringify({ ok: false, reason, message, next, ...extra }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Parse a JSON body without throwing. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
