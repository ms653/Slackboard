/** Stream-json parsing (TECH §7). Line-buffered; unknown types ignored. */
export interface ParseState {
  init?: { session_id?: string; model?: string; tools: string[]; mcp: { name: string; status?: string }[] };
  result?: { subtype?: string; total_cost_usd?: number; num_turns?: number; result?: string };
  lastText: string; permissionDenials: number; toolErrors: number; badLines: number; lastToolUse?: string;
}
export function newState(): ParseState { return { lastText: '', permissionDenials: 0, toolErrors: 0, badLines: 0 }; }

export function parseLine(s: ParseState, line: string): 'init' | 'tool_use' | 'result' | null {
  if (!line.trim()) return null;
  let m: any;
  try { m = JSON.parse(line); } catch { s.badLines++; return null; }
  if (m.type === 'system' && m.subtype === 'init') {
    s.init = { session_id: m.session_id, model: m.model, tools: Array.isArray(m.tools) ? m.tools : [],
      mcp: Array.isArray(m.mcp_servers) ? m.mcp_servers : [] };
    return 'init';
  }
  if (m.type === 'system' && m.subtype === 'permission_denied') { s.permissionDenials++; return null; }
  if (m.type === 'assistant') {
    let used: string | undefined;
    for (const c of m.message?.content ?? []) {
      if (c.type === 'text') s.lastText = String(c.text).slice(-2000);
      if (c.type === 'tool_use') used = `${c.name}${c.input?.file_path ? ' ' + c.input.file_path : ''}`;
    }
    if (used) { s.lastToolUse = used; return 'tool_use'; }
    return null;
  }
  if (m.type === 'user') { for (const c of m.message?.content ?? []) if (c.type === 'tool_result' && c.is_error) s.toolErrors++; return null; }
  if (m.type === 'result') {
    s.result = { subtype: m.subtype, total_cost_usd: m.total_cost_usd, num_turns: m.num_turns, result: m.result };
    if (Array.isArray(m.permission_denials)) s.permissionDenials = Math.max(s.permissionDenials, m.permission_denials.length);
    return 'result';
  }
  return null;
}

export const USAGE_LIMIT_RE = /usage limit|rate limit|limit reached|resets? at/i;
