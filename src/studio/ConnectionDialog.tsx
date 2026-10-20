import { useState } from "react";
import { askConfirm } from "@/lib/confirm";
import { Check, KeyRound, Trash2, TriangleAlert } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { del, get, post } from "@/api";
import MetaConnection, { useMetaStatus } from "./MetaConnection";

export interface EngineInfo {
  model: string;
  configured: boolean;
  source: "secret" | "stored" | "none";
  openai: "secret" | "stored" | "none";
  google: "secret" | "stored" | "none";
  fal: "secret" | "stored" | "none";
  review: boolean;
  vertex?: { project: string; location: string } | null;
}

export default function ConnectionDialog({
  open,
  engine,
  onClose,
  onChanged,
}: {
  open: boolean;
  engine: EngineInfo;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [savingGoogle, setSavingGoogle] = useState(false);
  const [vertexJson, setVertexJson] = useState("");
  const [vertexLocation, setVertexLocation] = useState("global");
  const [savingVertex, setSavingVertex] = useState(false);
  const [meta, refreshMeta] = useMetaStatus(open);

  async function saveVertex() {
    setSavingVertex(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/engine/vertex", {
        json: vertexJson,
        location: vertexLocation,
      });
      setVertexJson("");
      setResult(r);
      await onChanged();
      toast.success("Google Cloud service account saved and verified.");
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSavingVertex(false);
    }
  }

  async function removeVertex() {
    if (
      !(await askConfirm(
        "Remove the Google Cloud service account? Google calls go back to the AI Studio key, if one is saved.",
      ))
    )
      return;
    try {
      await del("/api/studio/engine/vertex");
      setResult(null);
      await onChanged();
      toast.success("Google Cloud service account removed.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const [falKey, setFalKey] = useState("");
  type Vendor = "higgsfield" | "google" | "vertex" | "openai" | "fal" | "meta";
  // Opens on the tab last used in this browser, else on the vendor of the current image model.
  const [vendor, setVendorState] = useState<Vendor>(() => {
    try {
      const saved = localStorage.getItem("connection-tab") as Vendor | null;
      if (saved && ["higgsfield", "google", "vertex", "openai", "fal", "meta"].includes(saved))
        return saved;
    } catch {
      /* private mode */
    }
    const m = engine.model || "";
    if (/^gemini/.test(m)) return engine.vertex ? "vertex" : "google";
    if (/^gpt/.test(m)) return "openai";
    if (/^fal\//.test(m)) return "fal";
    return "higgsfield";
  });
  const setVendor = (v: Vendor) => {
    setVendorState(v);
    try {
      localStorage.setItem("connection-tab", v);
    } catch {
      /* private mode */
    }
  };
  const [savingFal, setSavingFal] = useState(false);
  const [savingOpenai, setSavingOpenai] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function verify() {
    setChecking(true);
    try {
      setResult(await get<{ ok: boolean; message: string }>("/api/studio/engine/verify"));
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/engine/key", { key });
      setKey("");
      setResult(r);
      await onChanged();
      toast.success("Higgsfield key saved and verified.");
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function saveGoogle() {
    setSavingGoogle(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/engine/google-key", {
        key: googleKey,
      });
      setGoogleKey("");
      setResult(r);
      await onChanged();
      toast.success("Google key saved and verified.");
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSavingGoogle(false);
    }
  }

  async function saveFal() {
    setSavingFal(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/engine/fal-key", {
        key: falKey,
      });
      setFalKey("");
      await onChanged();
      toast.success(r.message || "fal.ai key saved and verified.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingFal(false);
    }
  }

  async function removeFal() {
    if (
      !(await askConfirm("Remove the saved fal.ai key? Seedream models stop until a new key is added."))
    )
      return;
    try {
      await del("/api/studio/engine/fal-key");
      await onChanged();
      toast.success("fal.ai key removed.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function removeGoogle() {
    if (
      !(await askConfirm(
        "Remove the saved Google key? Nano Banana models and automatic review stop until a new key is added.",
      ))
    )
      return;
    try {
      await del("/api/studio/engine/google-key");
      setResult(null);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveOpenai() {
    setSavingOpenai(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/engine/openai-key", {
        key: openaiKey,
      });
      setOpenaiKey("");
      setResult(r);
      await onChanged();
      toast.success("OpenAI key saved and verified.");
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSavingOpenai(false);
    }
  }

  async function removeOpenai() {
    if (
      !(await askConfirm(
        "Remove the saved OpenAI key? GPT Image models stop until a new key is added.",
      ))
    )
      return;
    try {
      await del("/api/studio/engine/openai-key");
      setResult(null);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveModel() {
    setSavingModel(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/engine/model", { model });
      setResult(r);
      setModel("");
      await onChanged();
      toast.success("Model saved.");
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSavingModel(false);
    }
  }

  async function remove() {
    if (
      !(await askConfirm("Remove the saved Higgsfield key? Generation stops until a new key is added."))
    )
      return;
    try {
      await del("/api/studio/engine/key");
      setResult(null);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="connection-dialog">
        <DialogHeader>
          <DialogTitle>Image engine connection</DialogTitle>
          <DialogDescription>
            One key per vendor; each is verified and stored encrypted on the server, never in the
            browser. Add the vendors whose models you want in the picker.
          </DialogDescription>
        </DialogHeader>

        <div className="vendor-tabs" role="tablist">
          {(
            [
              ["higgsfield", "Higgsfield", engine.configured],
              ["google", "Google", engine.google !== "none"],
              ["vertex", "Google Cloud", !!engine.vertex],
              ["openai", "OpenAI", engine.openai !== "none"],
              ["fal", "fal.ai", engine.fal !== "none"],
              ["meta", "Instagram", !!meta?.connected],
            ] as const
          ).map(([k, label, on]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={vendor === k}
              className={vendor === k ? "on" : ""}
              onClick={() => setVendor(k)}
            >
              <i className={`status-dot ${on ? "done" : "idle"}`} />
              {label}
            </button>
          ))}
        </div>
        {vendor === "higgsfield" && (
          <>
            {engine.configured ? (
              <div className="success-note">
                <Check size={19} />
                {engine.source === "secret"
                  ? "A Higgsfield key is configured as a server secret."
                  : "A Higgsfield key is saved on the server."}
              </div>
            ) : (
              <div className="error-banner">
                <TriangleAlert size={18} />
                No Higgsfield API key yet. Paste one below.
              </div>
            )}

            {engine.source !== "secret" && (
              <>
                <label htmlFor="engine-key" className="field-label">
                  Higgsfield API key
                </label>
                <input
                  id="engine-key"
                  type="password"
                  autoComplete="off"
                  placeholder="KEY_ID:KEY_SECRET"
                  value={key}
                  onChange={(e) => setKey(e.target.value.trim())}
                />
                <p className="quality-note">
                  Create it at{" "}
                  <a
                    href="https://cloud.higgsfield.ai"
                    target="_blank"
                    rel="noreferrer"
                    className="text-link"
                  >
                    cloud.higgsfield.ai
                  </a>{" "}
                  and paste it as the ID, a colon, then the secret. It is verified before it is
                  saved.
                </p>
                <div className="footer-actions">
                  <button className="primary" onClick={() => void save()} disabled={saving || !key}>
                    {saving ? (
                      <Orb size={17} />
                    ) : (
                      <KeyRound size={17} />
                    )}
                    {engine.configured ? "Replace key" : "Save key"}
                  </button>
                  {engine.source === "stored" && (
                    <button
                      className="secondary danger"
                      onClick={() => void remove()}
                      aria-label="Remove key"
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              </>
            )}

            <button
              className="secondary"
              onClick={() => void verify()}
              disabled={checking || !engine.configured}
            >
              {checking ? <Orb size={17} /> : <Check size={17} />}
              Test connection
            </button>
            {result && (
              <p className={result.ok ? "success-note" : "image-error"}>{result.message}</p>
            )}
          </>
        )}
        {vendor === "google" && (
          <>
            <div className="qa-heading" style={{ marginTop: 12 }}>
              <KeyRound size={18} />
              <strong>Google (Nano Banana Pro)</strong>
            </div>
            {engine.google !== "none" ? (
              <div className="success-note">
                <Check size={19} />
                {engine.google === "secret"
                  ? "A Google key is configured as a server secret."
                  : "A Google key is saved on the server."}{" "}
                It also powers the automatic review.
              </div>
            ) : (
              <p className="quality-note">
                Add a Google AI Studio key to use Nano Banana Pro directly. Create it at{" "}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  aistudio.google.com/apikey
                </a>{" "}
                on a project with billing enabled.
              </p>
            )}
            {engine.google !== "secret" && (
              <div className="footer-actions">
                <input
                  id="google-key"
                  type="password"
                  autoComplete="off"
                  placeholder="AIza..."
                  aria-label="Google API key"
                  value={googleKey}
                  onChange={(e) => setGoogleKey(e.target.value.trim())}
                />
                <button
                  className="primary"
                  onClick={() => void saveGoogle()}
                  disabled={savingGoogle || !googleKey}
                >
                  {savingGoogle ? (
                    <Orb size={17} />
                  ) : (
                    <KeyRound size={17} />
                  )}
                  {engine.google === "stored" ? "Replace" : "Save"}
                </button>
                {engine.google === "stored" && (
                  <button
                    className="secondary danger"
                    onClick={() => void removeGoogle()}
                    aria-label="Remove Google key"
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {vendor === "fal" && (
          <>
            <div className="qa-heading" style={{ marginTop: 12 }}>
              <KeyRound size={18} />
              <strong>fal.ai (Seedream 5)</strong>
            </div>
            {engine.fal !== "none" ? (
              <div className="success-note">
                <Check size={19} />
                {engine.fal === "secret"
                  ? "A fal.ai key is configured as a server secret."
                  : "A fal.ai key is saved on the server."}
              </div>
            ) : (
              <p className="quality-note">
                Add a fal.ai key to use Seedream 5.0 Pro and Lite. Create it at{" "}
                <a
                  href="https://fal.ai/dashboard/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  fal.ai/dashboard/keys
                </a>{" "}
                and add credit under Billing.
              </p>
            )}
            {engine.fal !== "secret" && (
              <div className="footer-actions">
                <input
                  id="fal-key"
                  type="password"
                  autoComplete="off"
                  placeholder="key_id:key_secret"
                  aria-label="fal.ai API key"
                  value={falKey}
                  onChange={(e) => setFalKey(e.target.value.trim())}
                />
                <button
                  className="primary"
                  onClick={() => void saveFal()}
                  disabled={savingFal || !falKey}
                >
                  {savingFal ? (
                    <Orb size={17} />
                  ) : (
                    <KeyRound size={17} />
                  )}
                  {engine.fal === "stored" ? "Replace" : "Save"}
                </button>
                {engine.fal === "stored" && (
                  <button
                    className="secondary danger"
                    onClick={() => void removeFal()}
                    aria-label="Remove fal.ai key"
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {vendor === "vertex" && (
          <>
            <div className="qa-heading" style={{ marginTop: 12 }}>
              <KeyRound size={18} />
              <strong>Google Cloud (Vertex AI)</strong>
            </div>
            {engine.vertex ? (
              <div className="success-note">
                <Check size={19} />
                Connected to project <b>{engine.vertex.project}</b> ({engine.vertex.location}).
                Every Google call (Nano Banana, the prompt writer, the checks and the review) now
                goes through Vertex AI and is billed to this project, so its Google Cloud credits
                pay first.
              </div>
            ) : (
              <p className="quality-note">
                The same Nano Banana models billed to a Google Cloud project instead of the AI
                Studio prepaid wallet, so the project&apos;s free credits can be used. Needs a
                service account: in Google Cloud, enable the Vertex AI API on the project with the
                credits, create a service account with the role <b>Vertex AI User</b>, add a JSON
                key to it and paste the downloaded file here.
              </p>
            )}
            <label className="field-label" htmlFor="vertex-json">
              Service-account JSON file
            </label>
            <textarea
              id="vertex-json"
              className="prompt"
              rows={6}
              value={vertexJson}
              onChange={(e) => setVertexJson(e.target.value)}
              placeholder='{ "type": "service_account", "project_id": "...", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----..." }'
              spellCheck={false}
            />
            <label className="field-label" htmlFor="vertex-location">
              Location (global is recommended)
            </label>
            <input
              id="vertex-location"
              className="text-input"
              value={vertexLocation}
              onChange={(e) => setVertexLocation(e.target.value)}
              placeholder="global"
            />
            <div className="footer-actions">
              {engine.vertex && (
                <button className="secondary danger" onClick={() => void removeVertex()}>
                  <Trash2 size={16} /> Remove
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button
                className="primary"
                disabled={savingVertex || vertexJson.trim().length < 20}
                onClick={() => void saveVertex()}
              >
                {savingVertex ? (
                  <Orb size={16} />
                ) : (
                  <Check size={16} />
                )}
                {engine.vertex ? "Replace" : "Save and verify"}
              </button>
            </div>
            <p className="prompt-tip">
              The file is verified with one tiny text call, then stored encrypted on the server.
              Images run one at a time per request on Vertex; Economy mode (Flex) is an AI Studio
              feature and is ignored while Vertex is connected.
            </p>
          </>
        )}
        {vendor === "openai" && (
          <>
            <div className="qa-heading" style={{ marginTop: 12 }}>
              <KeyRound size={18} />
              <strong>OpenAI (GPT Image 2.5 Sunburst / Flare)</strong>
            </div>
            {engine.openai !== "none" ? (
              <div className="success-note">
                <Check size={19} />
                {engine.openai === "secret"
                  ? "An OpenAI key is configured as a server secret."
                  : "An OpenAI key is saved on the server."}
              </div>
            ) : (
              <p className="quality-note">
                Add an OpenAI API key to use GPT Image 2.5 Sunburst. Create it at{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  platform.openai.com/api-keys
                </a>{" "}
                with billing enabled.
              </p>
            )}
            {engine.openai !== "secret" && (
              <div className="footer-actions">
                <input
                  id="openai-key"
                  type="password"
                  autoComplete="off"
                  placeholder="sk-..."
                  aria-label="OpenAI API key"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value.trim())}
                />
                <button
                  className="primary"
                  onClick={() => void saveOpenai()}
                  disabled={savingOpenai || !openaiKey}
                >
                  {savingOpenai ? (
                    <Orb size={17} />
                  ) : (
                    <KeyRound size={17} />
                  )}
                  {engine.openai === "stored" ? "Replace" : "Save"}
                </button>
                {engine.openai === "stored" && (
                  <button
                    className="secondary danger"
                    onClick={() => void removeOpenai()}
                    aria-label="Remove OpenAI key"
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {vendor === "meta" && <MetaConnection status={meta} onChanged={refreshMeta} />}
        <details className="prompt-details">
          <summary>Advanced: default model slug</summary>
          <label htmlFor="engine-model" className="field-label">
            Image model slug
          </label>
          <div className="footer-actions">
            <input
              id="engine-model"
              placeholder={engine.model}
              value={model}
              onChange={(e) => setModel(e.target.value.trim())}
              list="engine-models"
            />
            <datalist id="engine-models">
              <option value="nano-banana-pro" />
              <option value="flux-2-pro" />
              <option value="flux-2-max" />
              <option value="qwen-image-edit" />
              <option value="gemini-3-pro-image" />
              <option value="gemini-nano-banana-2.1" />
              <option value="gemini-3.1-flash-image" />
              <option value="gpt-image-2.5-sunburst" />
              <option value="gpt-image-2.5-flare" />
              <option value="gpt-image-2" />
            </datalist>
            <button
              className="secondary"
              onClick={() => void saveModel()}
              disabled={savingModel || !model || !engine.configured}
            >
              {savingModel ? <Orb size={17} /> : <Check size={17} />}
              Use model
            </button>
          </div>
          <p className="quality-note">
            The slug is checked with Higgsfield before it is saved. Models that are disabled on your
            account are rejected.
          </p>
        </details>

        <div className="connection-details">
          <span>Image model</span>
          <strong>{engine.model}</strong>
          <span>Automatic review</span>
          <strong>
            {engine.review
              ? engine.vertex
                ? "Gemini Flash (Google Cloud)"
                : "Gemini Flash (Google key)"
              : "Off until Google is connected"}
          </strong>
        </div>
      </DialogContent>
    </Dialog>
  );
}
