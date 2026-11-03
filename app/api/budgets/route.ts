import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { setBudgets, budgetsView } from '@/lib/server/actions';
export const GET = () => handle(() => budgetsView());
export const PUT = async (req: Request) => { const b = await body(req); return handle(() => setBudgets(b)); };
