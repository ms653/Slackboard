import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { postComment } from '@/lib/server/actions';
export const POST = async (req: Request, { params }: { params: { id: string } }) => { const b = await body(req); return handle(() => postComment(id(params), b)); };
