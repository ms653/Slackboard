import { handle, id } from '@/lib/server/route';
import { DomainError } from '@/lib/util';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { compareView } from '@/lib/server/read';
export const GET = (req: Request, { params }: { params: { id: string } }) => handle(() => {
  const from = Number(new URL(req.url).searchParams.get('from'));
  if (!Number.isInteger(from) || from < 1) throw new DomainError('validation_error', 'from=<artifactId> is required', 400);
  return compareView(id(params), from);
});
