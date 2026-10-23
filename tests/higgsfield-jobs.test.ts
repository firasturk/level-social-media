/**
 * The job ids in a Higgsfield answer. The generators answer JSON (`{jobs: [{job_id, …}]}`); the
 * picture tools (`upscale_image`, seen live on 23 Oct 2026) answer prose: "Submitted 1 job. If a
 * widget is visible, it polls automatically … \n- 30eade26-…". Both shapes must give the ids, or a
 * submitted (and charged) job is recorded as a failure.
 */
import { describe, expect, it } from "vitest";
import { parseJobs } from "../server/higgsfield-mcp";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

describe("the job ids of a Higgsfield answer", () => {
  it("reads JSON jobs with their status and result", () => {
    const jobs = parseJobs(text(JSON.stringify({ jobs: [{ index: 0, job_id: "job-1", status: "queued" }, { index: 1, job_id: "job-2", status: "completed", result: { url: "https://cdn.test/out.mp4" } }] })));
    expect(jobs).toEqual([
      { index: 0, jobId: "job-1", status: "queued", url: null, error: null },
      { index: 1, jobId: "job-2", status: "completed", url: "https://cdn.test/out.mp4", error: null },
    ]);
  });

  it("reads the UUIDs a prose 'Submitted N job' answer lists, and nothing from unrelated prose", () => {
    const prose = "Submitted 1 job. If a widget is visible, it polls automatically — do not call job_status or show_generations as a follow-up poll. In text-only clients, use job_status with sync:true to poll for completion.\n- 30eade26-8350-4c17-90cc-4be84fec9d83";
    expect(parseJobs(text(prose))).toEqual([{ index: 0, jobId: "30eade26-8350-4c17-90cc-4be84fec9d83", status: "queued", url: null, error: null }]);
    const two = "Submitted 2 jobs.\n- 30eade26-8350-4c17-90cc-4be84fec9d83\n- 6af8f167-e5f2-472e-94c8-41845e97c191";
    expect(parseJobs(text(two)).map((j) => j.jobId)).toEqual(["30eade26-8350-4c17-90cc-4be84fec9d83", "6af8f167-e5f2-472e-94c8-41845e97c191"]);
    expect(parseJobs(text("Input validation error: Invalid arguments for tool upscale_image: params.image_id: expected string"))).toEqual([]);
    expect(parseJobs(text("Your balance is 5606.75 credits."))).toEqual([]);
  });
});
