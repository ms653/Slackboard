import { NextResponse, type NextRequest } from 'next/server';

/** Localhost only (TECH §1): Host allowlist (DNS rebinding), Origin + session cookie on mutating requests. */
const SESSION = process.env.SB_SESSION_TOKEN || (globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()).replace(/-/g, '');

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  const port = host.split(':')[1] ?? '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return new NextResponse('Forbidden host', { status: 403 });
  const isApi = req.nextUrl.pathname.startsWith('/api/');
  const cookie = req.cookies.get('sb_session')?.value;
  if (isApi && req.method !== 'GET') {
    const origin = req.headers.get('origin');
    const okOrigin = origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    if (!okOrigin) return NextResponse.json({ ok: false, error: 'bad_origin', hint: 'cross-origin requests are refused' }, { status: 403 });
  }
  if (isApi && cookie !== SESSION) return NextResponse.json({ ok: false, error: 'session_invalid', hint: 'reload the page' }, { status: 401 });
  const res = NextResponse.next();
  if (!isApi && cookie !== SESSION) res.cookies.set('sb_session', SESSION, { httpOnly: true, sameSite: 'strict', path: '/' });
  return res;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
