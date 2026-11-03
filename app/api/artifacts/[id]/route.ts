import { handle, body, id } from '@/lib/server/route';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
import { artifactView } from '@/lib/server/read';
export const GET = (_: Request, { params }: { params: { id: string } }) => handle(() => artifactView(id(params)));
