import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { taskView } from '@/lib/server/read';
import { taskAction } from '@/lib/server/actions';
export const GET = (_: Request, { params }: { params: { id: string } }) => handle(() => taskView(id(params)));
export const POST = async (req: Request, { params }: { params: { id: string } }) => { const b = await body(req); return handle(() => taskAction(id(params), b.action, b.note, b.assignee)); };
