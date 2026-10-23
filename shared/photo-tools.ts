/**
 * The Photo studio's AI tools: provider tools on the post's picture, paid in credits (Higgsfield's
 * subscription, Magnific's balance). The static part lives here (the tools, their options, plain
 * words); the live part (which tools the servers list today, the option lists, the balances) comes
 * from `GET /api/studio/photo/tools/catalog`. The server maps each tool to an MCP tool by name and
 * each option to an argument by its schema (server/photo-tools.ts).
 */

export type ToolProvider = "higgsfield" | "magnific";

export const TOOL_PROVIDER_LABELS: Record<ToolProvider, string> = { higgsfield: "Higgsfield", magnific: "Magnific" };

export interface ToolChoice {
  id: string;
  label: string;
}

export interface ToolOption {
  id: "prompt" | "aspect" | "styleId" | "preset" | "mode" | "model" | "camera" | "scale";
  label: string;
  kind: "text" | "choice";
  required?: boolean;
  placeholder?: string;
  /** Fixed choices, or the catalog list that fills them. */
  choices?: ToolChoice[];
  fromCatalog?: "upscalePresets" | "upscaleModes" | "retouchModels" | "soulStyles";
}

export interface ToolDef {
  id: string;
  provider: ToolProvider;
  label: string;
  /** What it is good for, in plain words. */
  hint: string;
  /** The MCP tool the server calls. */
  mcpTool: string;
  options: ToolOption[];
}

const ASPECTS: ToolChoice[] = [
  { id: "1:1", label: "Square 1:1" },
  { id: "4:5", label: "Portrait 4:5" },
  { id: "9:16", label: "Story 9:16" },
  { id: "16:9", label: "Wide 16:9" },
];

export const PHOTO_TOOLS: readonly ToolDef[] = [
  { id: "hf-upscale", provider: "higgsfield", label: "Upscale", hint: "A sharper, larger picture for print and big posts.", mcpTool: "upscale_image", options: [] },
  { id: "hf-remove-bg", provider: "higgsfield", label: "Remove background", hint: "The product cut out on transparency.", mcpTool: "remove_background", options: [] },
  { id: "hf-outpaint", provider: "higgsfield", label: "Outpaint", hint: "More picture painted around the edges, in the same scene.", mcpTool: "outpaint_image", options: [{ id: "aspect", label: "New frame", kind: "choice", choices: ASPECTS }, { id: "prompt", label: "What the new edges show (optional)", kind: "text", placeholder: "e.g. more of the marble counter, soft shadows" }] },
  { id: "hf-relight", provider: "higgsfield", label: "Relight", hint: "New light on the picture from a few words; the product stays.", mcpTool: "relight_image", options: [{ id: "prompt", label: "The light wanted", kind: "text", required: true, placeholder: "e.g. warm evening light from the left" }] },
  {
    id: "hf-generate",
    provider: "higgsfield",
    label: "Generate with a style",
    hint: "A new picture of this one in a Soul style, from your words (the Styles presets).",
    mcpTool: "generate_image",
    options: [
      { id: "styleId", label: "Style", kind: "choice", fromCatalog: "soulStyles" },
      { id: "prompt", label: "What to make", kind: "text", required: true, placeholder: "e.g. the same cup on a sunlit café table, film look" },
      { id: "aspect", label: "Frame", kind: "choice", choices: ASPECTS },
    ],
  },
  { id: "mg-upscale", provider: "magnific", label: "Upscale", hint: "Magnific's own upscaler, with its presets and modes.", mcpTool: "images_upscale", options: [{ id: "preset", label: "Preset", kind: "choice", fromCatalog: "upscalePresets" }, { id: "mode", label: "Mode", kind: "choice", fromCatalog: "upscaleModes" }] },
  { id: "mg-relight", provider: "magnific", label: "Relight", hint: "New light from a few words; the product stays.", mcpTool: "images_relight", options: [{ id: "prompt", label: "The light wanted", kind: "text", required: true, placeholder: "e.g. soft studio light, a warm rim from the right" }] },
  { id: "mg-remove-bg", provider: "magnific", label: "Remove background", hint: "A clean cut-out on transparency.", mcpTool: "images_remove_background", options: [] },
  { id: "mg-replace-bg", provider: "magnific", label: "Replace background", hint: "The product kept, set into a scene you describe.", mcpTool: "images_replace_background", options: [{ id: "prompt", label: "The new scene", kind: "text", required: true, placeholder: "e.g. a marble counter in morning light" }] },
  { id: "mg-retouch", provider: "magnific", label: "Retouch", hint: "Small fixes from a few words: a crumb, a smudge, a label.", mcpTool: "images_retouch", options: [{ id: "model", label: "Model", kind: "choice", fromCatalog: "retouchModels" }, { id: "prompt", label: "What to fix", kind: "text", required: true, placeholder: "e.g. remove the crumbs on the plate" }] },
  { id: "mg-skin", provider: "magnific", label: "Skin enhancer", hint: "Natural skin on a person in the picture.", mcpTool: "images_skin_enhancer", options: [] },
  { id: "mg-expand", provider: "magnific", label: "Expand", hint: "More picture around the edges, to a new frame.", mcpTool: "images_expand", options: [{ id: "aspect", label: "New frame", kind: "choice", choices: ASPECTS }, { id: "prompt", label: "What the new edges show (optional)", kind: "text" }] },
  { id: "mg-restyle", provider: "magnific", label: "Restyle", hint: "The same picture in another look, from your words.", mcpTool: "images_restyle", options: [{ id: "prompt", label: "The look wanted", kind: "text", required: true, placeholder: "e.g. soft film photograph, muted colours" }] },
  { id: "mg-reimagine", provider: "magnific", label: "Reimagine", hint: "A fresh take on the picture that keeps its idea.", mcpTool: "images_reimagine", options: [{ id: "prompt", label: "Guidance (optional)", kind: "text" }] },
  {
    id: "mg-camera",
    provider: "magnific",
    label: "Change camera",
    hint: "The same scene from another angle.",
    mcpTool: "images_change_camera",
    options: [
      {
        id: "camera",
        label: "Angle",
        kind: "choice",
        required: true,
        choices: [
          { id: "front", label: "Front" },
          { id: "left", label: "From the left" },
          { id: "right", label: "From the right" },
          { id: "top", label: "From above" },
          { id: "low", label: "Low angle" },
          { id: "closer", label: "Closer" },
          { id: "wider", label: "Wider" },
        ],
      },
    ],
  },
  { id: "mg-variations", provider: "magnific", label: "Variations", hint: "A close variation of the picture.", mcpTool: "images_variations", options: [] },
] as const;

export function photoTool(id: string): ToolDef | undefined {
  return PHOTO_TOOLS.find((t) => t.id === id);
}

export type PhotoToolJobStatus = "queued" | "running" | "done" | "failed";

/** One job as the panel reads it. */
export interface PhotoToolJob {
  id: string;
  batch: string;
  post: number;
  provider: ToolProvider;
  tool: string;
  label: string;
  options: Record<string, string>;
  status: PhotoToolJobStatus;
  /** Credits named before the run; null = cost not known. */
  estimate: number | null;
  reported: number | null;
  error: string | null;
  input: string;
  output: string | null;
  created: number;
  updated: number;
}

export interface ProviderCatalog {
  provider: ToolProvider;
  /** Signed in (Higgsfield) or connected (Magnific). */
  connected: boolean;
  enabled: boolean;
  admin: boolean;
  /** Empty when the viewer may run this provider; otherwise why not. */
  reason: string;
  /** Credits on the balance, when it could be read. */
  balance: number | null;
  /** Per studio tool id: the server lists the MCP tool today (null = not asked, the viewer is not an admin). */
  available: Record<string, boolean | null>;
}

export interface ToolCatalog {
  admin: boolean;
  tools: ToolDef[];
  higgsfield: ProviderCatalog;
  magnific: ProviderCatalog;
  /** The Magnific option lists, when connected. */
  upscalePresets: ToolChoice[];
  upscaleModes: ToolChoice[];
  retouchModels: ToolChoice[];
  cachedAt: number;
}

export const ADMINS_ONLY_TOOLS = "Admins only for now: these tools spend the providers' credits; an admin opens them for the team once approved.";
