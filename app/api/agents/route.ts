import { handle, body } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { addAgent } from '@/lib/server/actions';
export const POST = async (req: Request) => { const b = await body(req); return handle(() => addAgent(b)); };
