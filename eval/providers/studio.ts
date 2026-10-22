/**
 * The promptfoo provider: one class that dispatches on vars.method to the studio's own prompt
 * builders and the demo fixture. No network, no database, no key. The same `run` is called from
 * tests/eval-fixtures.test.ts, so CI covers every method without promptfoo installed.
 */
import { briefPlan } from "./brief-plan";
import { gridIdeas } from "./grid-ideas";
import { themeAnalyse, themeShots } from "./theme-shots";
import { styleScene } from "./style-scene";
import { planScope } from "./plan-scope";
import { postPrompt } from "./post-prompt";
import { feedback } from "./feedback";

export const METHODS = {
  "brief-plan": briefPlan,
  "grid-ideas": gridIdeas,
  "theme-analyse": themeAnalyse,
  "theme-shots": themeShots,
  "style-scene": styleScene,
  "plan-scope": planScope,
  "post-prompt": postPrompt,
  feedback,
} as const;

export type Method = keyof typeof METHODS;

export async function run(method: string, vars: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const fn = METHODS[method as Method];
  if (!fn) throw new Error(`Unknown eval method "${method}". Known: ${Object.keys(METHODS).join(", ")}`);
  return (await fn(vars)) as Record<string, unknown>;
}

interface CallContext {
  vars?: Record<string, unknown>;
}

export default class StudioFixturesProvider {
  private readonly providerId: string;
  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? "studio-fixtures";
  }
  id(): string {
    return this.providerId;
  }
  async callApi(_prompt: string, context?: CallContext): Promise<{ output?: unknown; error?: string }> {
    const vars = context?.vars ?? {};
    try {
      return { output: await run(String(vars.method ?? ""), vars) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
