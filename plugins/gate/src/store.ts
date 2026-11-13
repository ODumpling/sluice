/**
 * Gate definitions live in the repository so they are versioned and reviewed:
 *   .sluice/gate/<TICKET>/ticket.yaml        id, title, spec (free text)
 *   .sluice/gate/<TICKET>/scenarios/<id>.yaml
 *   .sluice/gate/<TICKET>/approvals.json     human approvals bound to scenario hashes
 * `sluice gate run` reads them from the *base* revision, never from the PR.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { loadScenarioFile, scenarioHash, validateScenario, type Scenario } from './scenario.js';

export const GATE_DIR = join('.sluice', 'gate');

export interface Ticket {
  id: string;
  title: string;
  spec: string;
}

export interface Approval {
  scenario: string;
  sha256: string;
  approvedBy: string;
  approvedAt: string;
}

export type ApprovalStatus = 'approved' | 'unapproved' | 'stale';

export interface ScenarioState {
  scenario: Scenario;
  sha256: string;
  status: ApprovalStatus;
  approval?: Approval;
}

const TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class GateStore {
  constructor(readonly projectRoot: string) {}

  ticketDir(ticket: string): string {
    if (!TICKET_RE.test(ticket)) throw new Error(`invalid ticket id ${JSON.stringify(ticket)}`);
    return join(this.projectRoot, GATE_DIR, ticket);
  }

  tickets(): string[] {
    const d = join(this.projectRoot, GATE_DIR);
    return existsSync(d)
      ? readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];
  }

  hasTicket(ticket: string): boolean {
    return existsSync(join(this.ticketDir(ticket), 'ticket.yaml'));
  }

  readTicket(ticket: string): Ticket {
    const f = join(this.ticketDir(ticket), 'ticket.yaml');
    if (!existsSync(f)) throw new Error(`ticket ${ticket} not found (${f})`);
    const t = parseYaml(readFileSync(f, 'utf8')) as Ticket;
    if (t?.id !== ticket || typeof t.title !== 'string' || typeof t.spec !== 'string') {
      throw new Error(`${f}: needs id (= ${ticket}), title and spec`);
    }
    return t;
  }

  writeTicket(t: Ticket): void {
    mkdirSync(join(this.ticketDir(t.id), 'scenarios'), { recursive: true });
    writeFileSync(join(this.ticketDir(t.id), 'ticket.yaml'), toYaml(t));
  }

  scenarios(ticket: string): Scenario[] {
    const d = join(this.ticketDir(ticket), 'scenarios');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort()
      .map((f) => loadScenarioFile(join(d, f)));
  }

  /** Store proposed scenarios (replacing same-id drafts). Approvals of changed scenarios become stale. */
  propose(ticket: string, scenarios: unknown[]): Scenario[] {
    this.readTicket(ticket);
    const valid = scenarios.map((s, i) => validateScenario(s, `proposal #${i + 1}`));
    const ids = new Set<string>();
    for (const s of valid) {
      if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
      ids.add(s.id);
    }
    const d = join(this.ticketDir(ticket), 'scenarios');
    mkdirSync(d, { recursive: true });
    for (const s of valid) writeFileSync(join(d, `${s.id}.yaml`), toYaml(s));
    return valid;
  }

  approvals(ticket: string): Approval[] {
    const f = join(this.ticketDir(ticket), 'approvals.json');
    if (!existsSync(f)) return [];
    return (JSON.parse(readFileSync(f, 'utf8')) as { approvals: Approval[] }).approvals;
  }

  state(ticket: string): ScenarioState[] {
    const approvals = this.approvals(ticket);
    return this.scenarios(ticket).map((scenario) => {
      const sha256 = scenarioHash(scenario);
      const approval = [...approvals].reverse().find((a) => a.scenario === scenario.id);
      const status: ApprovalStatus = !approval ? 'unapproved' : approval.sha256 === sha256 ? 'approved' : 'stale';
      return { scenario, sha256, status, approval };
    });
  }

  /** Record a human approval of the current content of the given scenarios (default: all). */
  approve(ticket: string, approvedBy: string, ids?: string[], at: Date = new Date()): Approval[] {
    if (!approvedBy.trim()) throw new Error('approver identity required');
    const states = this.state(ticket);
    const chosen = ids?.length ? states.filter((s) => ids.includes(s.scenario.id)) : states;
    const missing = (ids ?? []).filter((id) => !states.some((s) => s.scenario.id === id));
    if (missing.length) throw new Error(`unknown scenario(s): ${missing.join(', ')}`);
    const existing = this.approvals(ticket).filter((a) => !chosen.some((c) => c.scenario.id === a.scenario));
    const added = chosen.map((c) => ({
      scenario: c.scenario.id,
      sha256: c.sha256,
      approvedBy,
      approvedAt: at.toISOString(),
    }));
    writeFileSync(
      join(this.ticketDir(ticket), 'approvals.json'),
      JSON.stringify({ approvals: [...existing, ...added] }, null, 2) + '\n',
    );
    return added;
  }

  revoke(ticket: string, id: string): void {
    const rest = this.approvals(ticket).filter((a) => a.scenario !== id);
    writeFileSync(join(this.ticketDir(ticket), 'approvals.json'), JSON.stringify({ approvals: rest }, null, 2) + '\n');
  }
}
