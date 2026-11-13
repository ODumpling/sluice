/** Run approved scenarios against a build and evaluate their expectations. */
import { getPath, interpolate, runScript, type Session } from '@sluice-dev/evidence';
import type { Json } from '@sluice-dev/fakes';
import type { Sandbox } from '@sluice-dev/sandbox';
import { match } from './matchers.js';
import { toScript, type Assertion, type HttpExpect, type Scenario } from './scenario.js';

export interface Failure {
  step: number;
  stepName: string;
  message: string;
}

export interface ScenarioRun {
  id: string;
  title: string;
  passed: boolean;
  failures: Failure[];
  session: Session;
  durationMs: number;
}

function evalAssertion(a: Assertion, ctx: { session: Session['steps']; fakes: Map<string, Json> }): string[] {
  if ('fake' in a) {
    const state = ctx.fakes.get(a.fake);
    if (state === undefined) return [`fake ${a.fake} is not running`];
    const actual = (a.path ? getPath(state, a.path) : state) as Json | undefined;
    return match(a.matches, actual, `${a.fake}${a.path ? '.' + a.path : ''}`).map((m) => m.message);
  }
  if ('egress' in a) {
    const calls = ctx.session.flatMap((s) => s.egress) as unknown as Json[];
    const errs: string[] = [];
    const matching = (p: Json) => calls.filter((c) => match(p, c).length === 0);
    if (a.egress.none !== undefined) {
      const hit = matching(a.egress.none);
      if (hit.length) {
        const c = hit[0] as { method: string; path: string; fake: string };
        errs.push(
          `expected no egress matching ${JSON.stringify(a.egress.none)}, but the app called ${c.fake} ${c.method} ${c.path}`,
        );
      }
    }
    if (a.egress.some !== undefined && matching(a.egress.some).length === 0) {
      errs.push(`expected an egress call matching ${JSON.stringify(a.egress.some)}, none made`);
    }
    if (a.egress.count) {
      const n = matching(a.egress.count.match).length;
      if (n !== a.egress.count.equals)
        errs.push(
          `expected ${a.egress.count.equals} egress call(s) matching ${JSON.stringify(a.egress.count.match)}, got ${n}`,
        );
    }
    return errs;
  }
  if ('events' in a) {
    const events = ctx.session.flatMap((s) => s.events);
    const errs: string[] = [];
    if (a.events.none !== undefined) {
      const hit = events.find((e) => match(a.events.none!, e).length === 0);
      if (hit)
        errs.push(
          `expected no event matching ${JSON.stringify(a.events.none)}, but the app emitted ${JSON.stringify(hit)}`,
        );
    }
    if (a.events.some !== undefined && !events.some((e) => match(a.events.some!, e).length === 0)) {
      errs.push(`expected an event matching ${JSON.stringify(a.events.some)}; emitted: ${JSON.stringify(events)}`);
    }
    return errs;
  }
  return []; // sql handled async in runScenario
}

export async function runScenario(
  sb: Sandbox,
  scenario: Scenario,
  opts: { sourceRoot: string; label: string },
): Promise<ScenarioRun> {
  const started = Date.now();
  const failures: Failure[] = [];
  const session = await runScript(sb, toScript(scenario), {
    label: opts.label,
    sourceRoot: opts.sourceRoot,
    async afterStep({ index, evidence, steps, vars, sandbox, db }) {
      const st = scenario.steps[index]!;
      const fail = (message: string): void => void failures.push({ step: index, stepName: evidence.name, message });
      if ('assert' in st) {
        const a = interpolate(st.assert as unknown as Json, vars) as unknown as Assertion;
        if ('sql' in a) {
          if (!db) {
            fail('sql assertion but the sandbox has no database');
            return;
          }
          try {
            const r = await db.query(a.sql, (a.params ?? []) as unknown[]);
            const rows = JSON.parse(JSON.stringify(r.rows)) as Json;
            for (const m of match(a.rows, rows, 'rows')) fail(`${a.sql}: ${m.message}`);
          } catch (e) {
            fail(`sql assertion failed to run: ${(e as Error).message}`);
          }
          return;
        }
        const fakes = new Map([...sandbox.fakes].map(([n, f]) => [n, f.fake.state()]));
        for (const m of evalAssertion(a, { session: steps, fakes })) fail(m);
        return;
      }
      const expect = (st as { expect?: HttpExpect }).expect;
      if (expect && evidence.response) {
        const e = interpolate(expect as unknown as Json, vars) as unknown as HttpExpect;
        if (e.status !== undefined && e.status !== evidence.response.status) {
          fail(`expected HTTP ${e.status}, got ${evidence.response.status} ${JSON.stringify(evidence.response.body)}`);
        } else if (e.body !== undefined) {
          for (const m of match(e.body, evidence.response.body, 'body')) fail(m.message);
        }
      }
    },
  });
  return {
    id: scenario.id,
    title: scenario.title,
    passed: failures.length === 0,
    failures,
    session,
    durationMs: Date.now() - started,
  };
}
