/**
 * The Magnific MCP sign-in: the shared OAuth helper (server/oauth-signin.ts) configured for
 * https://mcp.magnific.com, whose authorization server is the Keycloak realm
 * https://auth.magnific.com/realms/mcp (docs/freepik.md: open dynamic registration, authorization
 * code + PKCE, a device flow, `offline_access` in `scopes_supported`). Its own module so
 * server/freepik.ts (the status) and server/freepik-mcp.ts (the adapter and the routes) can both
 * read it without importing each other.
 */
import { OAuthSignIn } from "./oauth-signin";

export const MAGNIFIC_MCP_URL = "https://mcp.magnific.com";
export const MAGNIFIC_RESOURCE_METADATA = "https://mcp.magnific.com/.well-known/oauth-protected-resource";
/** What the server's Bearer challenge demands (verified 22 Oct 2026); `offline_access` is added only when the realm lists it. */
export const MAGNIFIC_SCOPES = "openid profile email mcp:custom-audience";
export const MAGNIFIC_CALLBACK_PATH = "/api/studio/freepik/mcp/callback";
export const MAGNIFIC_NOT_SIGNED_IN = "Not signed in: Connection → Freepik → Magnific MCP → Sign in to Magnific. The MCP tools run on that sign-in.";

/** Settings `freepik_mcp_client`, `freepik_mcp_tokens`, `freepik_mcp_pending` (server/settings.ts). */
export const magnificSignIn = new OAuthSignIn({
  label: "Magnific",
  ledgerProvider: "freepik",
  resource: MAGNIFIC_MCP_URL,
  protectedResourceUrl: MAGNIFIC_RESOURCE_METADATA,
  scopes: MAGNIFIC_SCOPES,
  optionalScopes: ["offline_access"],
  redirectPath: MAGNIFIC_CALLBACK_PATH,
  settingsPrefix: "freepik_mcp",
  clientName: "Level Studio",
  returnParam: "magnific",
  signInHint: "Connection → Freepik",
  notSignedIn: MAGNIFIC_NOT_SIGNED_IN,
});
