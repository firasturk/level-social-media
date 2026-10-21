/**
 * A fetch that refuses every network call unless the test asked for a paid or outside call by
 * name: a route reached by mistake (an engine, a text provider, Pinterest, Drive) fails the test
 * instead of spending anything. Nothing here can reach a real vendor: the fake answers only.
 */
import { vi } from "vitest";

export type Reached = { url: string; init?: RequestInit };

export function guardFetch(allow: (url: string) => boolean = () => false) {
  const reached: Reached[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    reached.push({ url, init });
    if (!allow(url)) throw new Error(`A network call was made without the test asking for it: ${url}`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", stub);
  return { reached, stub };
}
