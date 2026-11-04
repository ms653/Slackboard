import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { decide } from '@/lib/server/actions';
import { DomainError } from '@/lib/util';
export const POST = async (req: Request, { params }: { params: { id: string } }) => { const b = await body(req); return handle(() => { const n = id(params); if (b.decision !== 'approved' && b.decision !== 'rejected') throw new DomainError('validation_error', "decision must be 'approved' or 'rejected'", 400); return decide(n, b.decision, b.note, b.raise_concurrency_to); }); };
