/**
 * Which Higgsfield account pays for a video: the owner's subscription credits through the MCP
 * sign-in (server/higgsfield-mcp.ts), or the Cloud API key paid per clip (server/higgsfield.ts).
 * The two are separate billing accounts; the choice routes every submission and refuses the other
 * path with a plain message. Kept apart from both adapters so server/video.ts can read it without
 * importing the MCP module.
 */
import type { Env } from "./env";
import { getSetting, HIGGSFIELD_BILLING_SETTING, HIGGSFIELD_MCP_TOKENS_SETTING } from "./settings";

export type HiggsfieldBilling = "credits" | "cloud";

/** The admin's choice; with none made, the subscription credits once a Higgsfield sign-in exists, else the Cloud API. */
export async function higgsfieldBilling(env: Env): Promise<HiggsfieldBilling> {
  const v = await getSetting(env, HIGGSFIELD_BILLING_SETTING);
  if (v === "credits" || v === "cloud") return v;
  return (await getSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING)) ? "credits" : "cloud";
}

export const CREDITS_CHOSEN = "Videos are set to use the subscription credits (Higgsfield sign-in). Switch the billing under Connection → Higgsfield to use the Cloud API.";
export const CLOUD_CHOSEN = "Videos are set to use the Cloud API key (pay per clip). Switch the billing under Connection → Higgsfield to use the subscription credits.";
