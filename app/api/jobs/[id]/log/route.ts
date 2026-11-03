import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { jobLog } from '@/lib/server/actions';
export const GET = (_: Request, { params }: { params: { id: string } }) => handle(() => jobLog(id(params)));
