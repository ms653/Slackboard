import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { newTask } from '@/lib/server/actions';
export const POST = async (req: Request) => { const b = await body(req); return handle(() => newTask(b)); };
