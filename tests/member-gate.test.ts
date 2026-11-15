import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP_GUIDE } from "../shared/help-guide";

/**
 * The owner's direction of 15 Nov 2026, as far as it can be checked without a browser
 * (scripts/member-smoke.mjs walks the screens as a member and as an admin):
 *  1. technical controls are drawn for an admin only;
 *  2. the confirmations that asked about one restorable, inexpensive step are gone, the others stay;
 *  3. the extra ways to start a month that duplicated Start are gone.
 */

const src = (path: string) => readFileSync(path, "utf8");
/** The first `needle` in a file with the few lines before it: where a control is drawn. */
function before(path: string, needle: string, lines = 4): string {
  const text = src(path);
  const at = text.indexOf(needle);
  expect(at, `${path} no longer has: ${needle}`).toBeGreaterThan(-1);
  return text.slice(0, at).split("\n").slice(-lines).join("\n");
}
const calls = (path: string, what: string) => src(path).split(what).length - 1;

describe("1. technical controls are the admins'", () => {
  it("the left menu's connection entry is a button for an admin and text for a member", () => {
    const side = src("src/studio/Sidebar.tsx");
    expect(before("src/studio/Sidebar.tsx", "onClick={onConnection}", 4)).toContain('{user.role === "admin" ? (');
    expect(side.match(/onClick=\{onConnection\}/g)).toHaveLength(1);
    expect(side).toContain('<div className={`sidebar-connection status ${connected ? "connected" : ""}`} role="status"');
  });

  it("the Connection dialog opens for an admin only; a member is told who can connect the engine", () => {
    const work = src("src/studio/Workspace.tsx");
    // The helper, the return from a sign-in (already admin only) and the left menu's button (admin only).
    expect(work.match(/setConnection\(true\)/g)).toHaveLength(3);
    expect(work).toContain("if (isAdmin) setConnection(true);");
    expect(work).toContain('else toast.error("The image engine is not connected. Ask an admin to connect it.");');
    expect(work).toContain('if (user.role === "admin") setConnection(true);');
    expect(work.match(/askForEngine\(\);/g)).toHaveLength(5);
    expect(before("src/studio/Workspace.tsx", "<ConnectionDialog", 2)).toContain("{isAdmin && (");
  });

  it("the side panel's Output section is drawn for an admin only", () => {
    expect(before("src/studio/BrandPanel.tsx", '<Section kit="output"', 2)).toContain("{isAdmin && (");
    expect(src("src/studio/Workspace.tsx")).toContain("isAdmin={isAdmin}");
  });

  it("Direction and the Plan draw their technical controls for an admin only", () => {
    const flow = "src/studio/Flow.tsx";
    expect(src(flow)).toContain('const isAdmin = p.user.role === "admin";');
    // Direction.
    expect(before(flow, "Analyse the pins", 3)).toContain("{isAdmin && theme && theme.references > 0");
    expect(before(flow, '<div className="flow-precedence-strip">', 2)).toContain("{isAdmin && (");
    expect(before(flow, '<div className="flow-colour-sources"', 2)).toContain("{isAdmin && (");
    expect(src(flow)).toContain("{isAdmin && (!editColours ? (");
    expect(before(flow, '<span className="flow-eyebrow">Format and engine</span>', 3)).toContain("{isAdmin && (");
    // The Plan.
    expect(before(flow, "Read the scenes before paying\n", 3)).toContain("{isAdmin && (");
    expect(before(flow, "Read again\n", 3)).toContain("{isAdmin && (");
    expect(before(flow, "Write the shots\n", 6)).toContain("(isAdmin ? (");
    expect(before(flow, "<summary>What will guide this picture</summary>", 3)).toContain("{isAdmin && o?.guide?.length ? (");
    expect(before(flow, "<TestGrid ", 3)).toContain("{isAdmin && p.batchId && p.plan.length > 0 && (");
    expect(before(flow, "Make one test picture", 3)).toContain("{isAdmin && ready.find((x) => x.paid) && (");
    expect(before(flow, "<input type=\"checkbox\" checked={retakes}", 3)).toContain("{isAdmin && (");
  });

  it("what a member needs on the Plan is not behind the gate", () => {
    const flow = "src/studio/Flow.tsx";
    for (const kept of ["Talk to the planner", "Write the ideas again\n", "Add posts\n", "Allow on this post\n", "Keep my reference attached anyway", "Save the plan, make nothing\n", "Choose a product image\n"]) expect(before(flow, kept, 3), kept).not.toContain("isAdmin &&");
    // The warning a member reads never names a button they do not have.
    expect(src(flow)).toContain("no written scene yet");
    expect(src(flow)).toContain("the scene is read by itself when the picture is made");
  });
});

describe("2. confirmations", () => {
  it("one picture, a restorable month, a grid, a rewrite and an exception are no longer asked about", () => {
    // What stays: the planner's pictures, the older pictures made again, the whole month.
    expect(calls("src/studio/Flow.tsx", "askConfirm(")).toBe(3);
    // What stays: a style on chosen cards, a restyle.
    expect(calls("src/studio/PlanView.tsx", "askConfirm(")).toBe(2);
    // What stays: leaving a post whose changes could not be saved.
    expect(calls("src/studio/ReviewDialog.tsx", "askConfirm(")).toBe(1);
    // What stays: applying adjustments, closing with unsaved work.
    expect(calls("src/studio/photo/PhotoStudio.tsx", "askConfirm(")).toBe(2);
    expect(calls("src/studio/CampaignSizeCard.tsx", "askConfirm(")).toBe(0);
    // What stays: a product photo with its posts, a style's pictures, the whole month again, the client's picture, the client's changes, deleting for good.
    expect(calls("src/studio/Workspace.tsx", "askConfirm(")).toBe(6);
    const work = src("src/studio/Workspace.tsx");
    for (const kept of ["Remove this product photo and the posts generated from it?", "for good? Its pictures, products and posts cannot be brought back", "replaces what the client sees", 'cancel: "Keep the current pictures"']) expect(work, kept).toContain(kept);
    expect(src("src/studio/Flow.tsx")).toContain("{ ok: `Make ${readyPictures} · about ${formatUsd(total)}`, danger: false, cancel: \"Not now\" }");
  });

  it("each one says what happened and where the earlier thing is kept", () => {
    const work = src("src/studio/Workspace.tsx");
    expect(work).toContain('one paid picture is being made.${kept ? " The current picture stays under Versions." : ""}');
    expect(work).toContain("paid picture is being made from your edit. The current picture stays under Versions.");
    expect(work).toContain("The earlier plan, its words and its pictures are under Versions");
    expect(work).toContain("The earlier plan is under Versions; pictures already made stay until they are made again.");
    // A month to the bin: the message brings it back.
    expect(work.match(/action: \{ label: "Undo", onClick: \(\) => void restorePlan\(b\) \}/g)).toHaveLength(2);
    expect(src("src/studio/Flow.tsx")).toContain("Allowed on post ${x.index} only");
  });

  it("a Freepik download that takes credits is still confirmed; one in the plan is not", () => {
    const fp = src("src/studio/FreepikPanel.tsx");
    expect(before("src/studio/FreepikPanel.tsx", "const ok = await askConfirm(`Download", 3)).toContain("if (estimate !== 0) {");
    expect(fp).toContain('if (!ok) throw new Error("Not downloaded.");');
  });

  it("the spend-limit approval the server no longer asks for is gone from the studio", () => {
    expect(src("src/studio/Workspace.tsx")).not.toMatch(/needsApproval|Approve and generate/);
    // The server: no reservation is refused, so no run asks for an approval.
    const spend = src("server/spend.ts");
    expect(spend).toMatch(/export async function spendFits[\s\S]{0,400}return \{ ok: true, status: await spendStatus\(env, scope\) \};/);
    // The Generate route answers 409 only through StudioError; none of them carries needsApproval there.
    const generate = src("server/posts.ts");
    const run = generate.slice(generate.indexOf("export async function generateRun("), generate.indexOf("export async function generateRun(") + 6000);
    expect(run).not.toContain("needsApproval");
  });
});

describe("3. one way to start", () => {
  it('the month tools no longer plan from a reference grid, and Start has no "Fresh grid" shortcut', () => {
    expect(src("src/studio/PlanView.tsx")).not.toMatch(/From reference grid|gridPicker|onGridIdeas/);
    const flow = src("src/studio/Flow.tsx");
    expect(flow).not.toMatch(/Fresh grid in|onNewGrid/);
    expect(flow).toContain("in the Studio");
    expect(flow).toContain("Continue from {monthLabel(p.previousMonth)}");
  });

  it('the "style" way is gone and a tab that remembered it opens on the month\'s own lead; "refs" stays', () => {
    const flow = src("src/studio/Flow.tsx");
    expect(flow).toContain('type Way = "brief" | "grid" | "refs" | "images" | "video";');
    expect(flow).not.toMatch(/way === "style"|setWay\("style"\)|startStyle|styleTarget|onePost/);
    expect(flow).toContain("return saved?.way && KNOWN_WAYS.includes(saved.way) ? (saved.way as Way) : null;");
    // Still reachable: a direct route on a month with neither a brief nor a grid.
    expect(flow).toContain('setWay(p.config?.gridRef ? "grid" : p.config?.campaign ? "brief" : "refs")');
    expect(flow).toContain('{way === "refs" && client && (');
  });
});

describe("the help guide follows", () => {
  it("says who sees the technical controls and what is no longer asked", () => {
    expect(HELP_GUIDE).toMatch(/Technical settings are for admins and a member does not see them at all/);
    expect(HELP_GUIDE).toMatch(/"Output" \(admins only; a member does not see this section\)/);
    expect(HELP_GUIDE).toMatch(/"Format and engine" \(admins only\)/);
    expect(HELP_GUIDE).not.toMatch(/Fresh grid in|From reference grid|Approve and generate|asks "Follow this grid"/);
    expect(HELP_GUIDE).toMatch(/One picture for one post is made at once/);
    expect(HELP_GUIDE).toMatch(/goes to the Bin at once, without asking; the message offers "Undo"/);
  });
});
