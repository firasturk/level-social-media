/**
 * Prompt function for the paid config: the planner's real instruction (shared/campaign.ts) built
 * from the test's vars, exactly as /campaign builds it, sent to the configured text model.
 */
import { briefPlanInstruction } from "../../shared/campaign";
import { CLIENT, PRODUCTS, num, str } from "../providers/fixtures";

export default function briefPlanPrompt({ vars }: { vars: Record<string, unknown> }): string {
  return briefPlanInstruction({
    client: CLIENT.name,
    brief: str(vars.brief),
    month: "2026-11",
    products: PRODUCTS.map((p) => ({ name: p.name, note: p.note })),
    references: 0,
    brand: { style: CLIENT.style, tone: CLIENT.tone, dos: CLIENT.dos, donts: CLIENT.donts },
    language: CLIENT.language,
    existing: num(vars.existing, 0),
  });
}
