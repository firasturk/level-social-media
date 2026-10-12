import { describe, expect, it } from "vitest";
import { parseServiceAccount, signAssertion, vertexModelId, vertexToken } from "../server/vertex";

async function makeKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

describe("Vertex AI connection", () => {
  it("reads a service-account file and maps model ids", async () => {
    const { pem } = await makeKeyPair();
    const creds = parseServiceAccount(
      JSON.stringify({
        type: "service_account",
        project_id: "p1",
        client_email: "sa@p1.iam",
        private_key: pem,
      }),
      "US-Central1",
    );
    expect(creds).toMatchObject({
      projectId: "p1",
      clientEmail: "sa@p1.iam",
      location: "us-central1",
    });
    expect(() => parseServiceAccount("{}")).toThrow(/service-account/);
    expect(() => parseServiceAccount("not json")).toThrow(/JSON/);
    expect(vertexModelId("gemini-3-pro-image")).toBe("gemini-3-pro-image-preview");
    expect(vertexModelId("gemini-2.5-flash-image")).toBe("gemini-2.5-flash-image");
  });

  it("signs a JWT the token endpoint can verify and caches the token", async () => {
    const { pem, publicKey } = await makeKeyPair();
    const creds = {
      projectId: "p1",
      clientEmail: "sa@p1.iam",
      privateKey: pem,
      location: "global",
    };
    const jwt = await signAssertion(creds, 1_700_000_000);
    const [h, c, sig] = jwt.split(".");
    const unb64 = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(unb64(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(unb64(c)));
    expect(claims).toMatchObject({
      iss: "sa@p1.iam",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      unb64(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    expect(await vertexToken(creds, fetchImpl)).toBe("tok");
    expect(await vertexToken(creds, fetchImpl)).toBe("tok");
    expect(calls).toBe(1);
  });
});
