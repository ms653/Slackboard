import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { unblockKilled } from '@/lib/server/actions';
export const POST = () => handle(() => unblockKilled());
