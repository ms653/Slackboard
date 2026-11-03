import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { threadView } from '@/lib/server/read';
import { threadAction } from '@/lib/server/actions';
export const GET = (_: Request, { params }: { params: { id: string } }) => handle(() => threadView(id(params)));
export const POST = async (req: Request, { params }: { params: { id: string } }) => { const b = await body(req); return handle(() => threadAction(id(params), b.action)); };
