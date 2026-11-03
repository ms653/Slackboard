import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { bootstrap } from '@/lib/server/read';
export const GET = () => handle(() => bootstrap());
