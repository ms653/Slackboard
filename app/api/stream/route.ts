import { db } from '@/lib/db';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

/** SSE: polls events by id every 250 ms; client resumes from ?after=<id> (TECH §1). */
export async function GET(req: Request) {
  let after = Number(new URL(req.url).searchParams.get('after') || 0);
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`retry: 2000\n\n`));
      let ticks = 0;
      timer = setInterval(() => {
        try {
          const rows = db().prepare(`SELECT id, ts, type, actor, entity_type, entity_id, job_id, payload FROM events WHERE id > ? ORDER BY id LIMIT 500`).all(after) as any[];
          for (const r of rows) { after = r.id; ctrl.enqueue(enc.encode(`id: ${r.id}\ndata: ${JSON.stringify({ ...r, payload: JSON.parse(r.payload) })}\n\n`)); }
          if (++ticks % 40 === 0) ctrl.enqueue(enc.encode(`: ping\n\n`));
        } catch { clearInterval(timer); try { ctrl.close(); } catch {} }
      }, 250);
      req.signal.addEventListener('abort', () => { clearInterval(timer); try { ctrl.close(); } catch {} });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
