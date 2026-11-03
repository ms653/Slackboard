import { describe, it, expect, afterEach } from 'vitest';
import { Env } from './harness';
import { setDbForTests } from '@/lib/db';
import { setBudgets, sendMessage } from '@/lib/server/actions';
import { bootstrap } from '@/lib/server/read';

let env: Env;
afterEach(async () => { setDbForTests(null); await env?.stop(); });

describe('S4 (budget hit, PRD §5)', () => {
  it('day limit below one job cap -> job stays queued, budget.hit emitted, zero job.started after it, blocked_by=budget', async () => {
    env = new Env({});
    setDbForTests(env.db);
    env.start();
    await env.until(() => env.one(`SELECT doctor_ok_at FROM system_state`).doctor_ok_at, 30000, 'doctor');
    setBudgets({ day_usd: 0.1 });                       // director respond cap is 0.40
    sendMessage(null, 'please do something');
    const hit = await env.until(() => env.one(`SELECT id FROM events WHERE type='budget.hit' ORDER BY id LIMIT 1`), 15000, 'budget.hit');
    await new Promise((r) => setTimeout(r, 2500));
    expect(env.one(`SELECT count(*) n FROM events WHERE type='job.started' AND id>?`, hit.id).n).toBe(0);
    expect(env.one(`SELECT count(*) n FROM jobs WHERE status='queued' AND agent_id='director'`).n).toBeGreaterThanOrEqual(1);
    expect(env.one(`SELECT count(*) n FROM jobs WHERE status='running'`).n).toBe(0);
    expect(bootstrap().system.blocked_by).toBe('budget');
  });
});
