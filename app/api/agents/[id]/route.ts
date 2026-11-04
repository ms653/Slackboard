import { handle, body } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { setAgent, retire } from '@/lib/server/actions';
import { DomainError } from '@/lib/util';
export const PUT = async (req: Request, { params }: { params: { id: string } }) => {
  const b = await body(req);
  return handle(() => {
    if (b.retire === true) return retire(params.id);
    if (typeof b.enabled !== 'boolean') throw new DomainError('validation_error', 'send {enabled: boolean} or {retire: true}', 400);
    return setAgent(params.id, b.enabled);
  });
};
