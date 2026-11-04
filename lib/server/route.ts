import { NextResponse } from 'next/server';
import { DomainError } from '../util';

/** Uniform JSON + error shape {ok:false, error, hint} (TECH §1.1). */
export async function handle(fn: () => unknown | Promise<unknown>) {
  try {
    const r = await fn();
    return NextResponse.json({ ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : { data: r }) });
  } catch (e: any) {
    if (e instanceof DomainError) return NextResponse.json({ ok: false, error: e.code, hint: e.hint, ...(e.extra ?? {}) }, { status: e.status });
    const msg = String(e?.message ?? e);
    const code = msg.match(/^[a-z_]+$/)?.[0] ?? (/SQLITE_BUSY|locked/.test(msg) ? 'db_locked' : 'internal_error');
    console.error('[api]', msg);
    return NextResponse.json({ ok: false, error: code, hint: code === 'internal_error' ? msg.slice(0, 200) : msg }, { status: code === 'internal_error' ? 500 : 409 });
  }
}
export async function body(req: Request): Promise<any> { try { return await req.json(); } catch { return {}; } }
export const id = (p: { id: string }) => { const n = Number(p.id); if (!Number.isInteger(n)) throw new DomainError('validation_error', 'bad id', 400); return n; };
