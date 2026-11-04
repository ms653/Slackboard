import { describe, expect, it } from 'vitest';
import { groupSystemRuns } from '../../components/Views';

const sys = (id: number) => ({ id, first_author: 'agent', first_agent: null });
const you = (id: number) => ({ id, first_author: 'user', first_agent: null });

describe('groupSystemRuns', () => {
  it('collapses runs of 3+ system roots, leaves shorter runs inline', () => {
    const out = groupSystemRuns([sys(1), sys(2), sys(3), you(4), sys(5), sys(6), you(7)]);
    expect(out.map((o) => o.kind)).toEqual(['group', 'row', 'row', 'row', 'row']);
    expect((out[0] as any).ths.map((t: any) => t.id)).toEqual([1, 2, 3]);
  });
  it('groups a trailing run', () => {
    expect(groupSystemRuns([you(1), sys(2), sys(3), sys(4)]).map((o) => o.kind)).toEqual(['row', 'group']);
  });
});
