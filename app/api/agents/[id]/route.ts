import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { setAgent } from '@/lib/server/actions';
export const PUT = async (req: Request, { params }: { params: { id: string } }) => { const b = await body(req); return handle(() => setAgent(params.id, !!b.enabled)); };
