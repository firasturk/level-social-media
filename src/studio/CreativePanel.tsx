import { lazyScreen } from "@/lib/lazy";
import {
  Bookmark,
  Check,
  FileImage,
  LoaderCircle,
  Pencil,
  PiggyBank,
  ScanLine,
  Trash2,
  X,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { del, get, post } from "@/api";
import { Switch } from "@/components/ui/switch";
import Picker from "./Picker";
const SkillDialog = lazyScreen(() => import("./SkillDialog"));
import { ChevronDown, Plus, RotateCcw, Star } from "lucide-react";
const ReferenceLibrary = lazyScreen(() => import("./ReferenceLibrary"));
const DirectionRules = lazyScreen(() => import("./DirectionRules"));
import {
  DEFAULT_PROMPT,
  SCENES,
  INPUT_TYPES,
  MARKETS,
  MAX_COUNT,
  OUTPUT_FORMATS,
  RATIOS,
  SIZES,
  backdropColors,
  type Config,
  isSkillCampaign,
  usesBuilder,
} from "@shared/config";
import type { EngineModel, LookInfo, Preset, SkillInfo, MoodBoardInfo } from "@shared/types";

const COUNTS = Array.from({ length: MAX_COUNT }, (_, i) => String(i + 1));

export default function CreativePanel({
  config,
  locked,
  saved,
  models,
  defaultModel,
  onChange,
  editing = false,
  canEdit = false,
  saving = false,
  onEdit,
  onSave,
  onCancel,
  presets = [],
  onPresetsChanged,
  defaultDirection = "",
  moodBoard = null,
  onMoodBoardChanged,
  onDirectionSaved,
  skills = [],
  onSkillsChanged,
  looks = [],
  onLooksChanged,
}: {
  config: Config;
  locked: boolean;
  saved: boolean;
  models: EngineModel[];
  defaultModel: string;
  onChange: (patch: Partial<Config>) => void;
  editing?: boolean;
  canEdit?: boolean;
  saving?: boolean;
  onEdit?: () => void;
  onSave?: () => void;
  onCancel?: () => void;
  presets?: Preset[];
  onPresetsChanged?: () => Promise<void>;
  /** Mode 7: the shared default direction text. */
  defaultDirection?: string;
  /** Creative direction: the Mood board entry as the team keeps it (name, tagline, hidden, starred). */
  moodBoard?: MoodBoardInfo | null;
  onMoodBoardChanged?: (mb: MoodBoardInfo) => void;
  onDirectionSaved?: (text: string) => void;
  /** Skills as the server lists them (built-in plus team edits and additions). */
  skills?: SkillInfo[];
  onSkillsChanged?: (skills: SkillInfo[], selectId?: string) => void;
  /** Saved looks (prompts the team liked) for every skill. */
  looks?: LookInfo[];
  onLooksChanged?: () => void;
}) {
  const [skillEditor, setSkillEditor] = useState<{ open: boolean; skill: SkillInfo | null }>({
    open: false,
    skill: null,
  });
  // Zaid creative direction lists Zaid's own mood board first, then the shared skills.
  const zaidMode = config.mode === "7";
  const [zaidThumb, setZaidThumb] = useState<string | undefined>();
  useEffect(() => {
    if (!zaidMode) return;
    get<{ references: { id: string }[] }>("/api/studio/references?skill=zaid")
      .then((r) => setZaidThumb(r.references[0]?.id))
      .catch(() => setZaidThumb(undefined));
  }, [zaidMode]);
  const zaidEntry: SkillInfo = {
    id: "zaid",
    title: moodBoard?.title ?? "Mood board",
    caption: moodBoard?.caption ?? "Mood board world · prompt structure",
    description:
      moodBoard?.description ??
      "Each image gets a new scene from the mood board, written in the creative-direction prompt structure. Add notes below only when a batch needs something specific (a city, a colour story, a pose).",
    goal: defaultDirection,
    library: "",
    favourite: !!moodBoard?.favourite,
    builtIn: true,
    edited: false,
    auto: false,
    thumb: zaidThumb,
  };
  // Creative direction: the Mood board entry sits first unless other skills are starred and it is
  // not; a hidden Mood board is left out entirely.
  const moodHidden = zaidMode && !!moodBoard?.hidden;
  const skillList = !zaidMode
    ? skills
    : moodHidden
      ? skills
      : zaidEntry.favourite
        ? [zaidEntry, ...skills]
        : [...skills.filter((x) => x.favourite), zaidEntry, ...skills.filter((x) => !x.favourite)];
  const currentSkill = skillList.find((s) => s.id === config.skill) ?? skillList[0];
  useEffect(() => {
    if (moodHidden && config.skill === "zaid" && skills[0] && !locked)
      onChange({ skill: skills[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moodHidden, config.skill, skills.length]);
  const isZaidEntry = currentSkill?.id === "zaid";
  const skillLooks = looks.filter((l) => l.skill === (config.skill || "editorial"));
  const currentLook = skillLooks.find((l) => l.id === config.look) ?? null;
  async function deleteLook(l: LookInfo) {
    if (!window.confirm(`Delete the saved look "${l.name}"?`)) return;
    try {
      await del(`/api/studio/looks/${encodeURIComponent(l.id)}`);
      onChange({ look: undefined });
      onLooksChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const [rebuilding, setRebuilding] = useState(false);

  /** After the library changes, an automatic skill gets its text rewritten from the photos. */
  async function libraryChanged(count: number) {
    if (!currentSkill?.auto) return;
    if (count === 0) return;
    setRebuilding(true);
    try {
      const r = await post<{ skills: SkillInfo[] }>(
        `/api/studio/skills/${currentSkill.id}/analyze`,
        { title: currentSkill.title, save: true },
      );
      onSkillsChanged?.(r.skills, currentSkill.id);
      toast.success("Skill text updated from its reference photos.");
    } catch (e) {
      toast.error(`Could not update the skill text: ${(e as Error).message}`);
    } finally {
      setRebuilding(false);
    }
  }

  const [dragId, setDragId] = useState<string | null>(null);

  async function toggleFavourite(s: SkillInfo) {
    try {
      const r = await post<{ skills: SkillInfo[] }>(`/api/studio/skills/${s.id}/favourite`, {
        on: !s.favourite,
      });
      if (s.id === "zaid" && moodBoard)
        onMoodBoardChanged?.({ ...moodBoard, favourite: !s.favourite });
      onSkillsChanged?.(r.skills);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** Drops the dragged card before the target and saves the team-wide order. */
  async function reorder(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = skills.map((s) => s.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    setDragId(null);
    try {
      const r = await post<{ skills: SkillInfo[] }>("/api/studio/skills/order", { ids });
      onSkillsChanged?.(r.skills);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function deleteSkill() {
    if (!currentSkill) return;
    if (currentSkill.id === "zaid") {
      if (
        !window.confirm(
          `Hide "${currentSkill.title}" from the skill picker? Its photos stay in the library and you can restore it with "Restore ${currentSkill.title}".`,
        )
      )
        return;
      try {
        const r = await del<{ moodBoard: MoodBoardInfo }>("/api/studio/direction-skill");
        onMoodBoardChanged?.(r.moodBoard);
        toast.success(`${currentSkill.title} hidden.`);
      } catch (e) {
        toast.error((e as Error).message);
      }
      return;
    }
    const msg = currentSkill.builtIn
      ? `Hide the built-in skill "${currentSkill.title}"? You can restore it later from Edit.`
      : `Delete the skill "${currentSkill.title}"? Its reference photos stay in the library.`;
    if (!window.confirm(msg)) return;
    try {
      const r = await del<{ skills: SkillInfo[] }>(`/api/studio/skills/${currentSkill.id}`);
      onSkillsChanged?.(r.skills);
      toast.success(currentSkill.builtIn ? "Skill hidden." : "Skill deleted.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function restoreMoodBoard() {
    try {
      const r = await post<{ moodBoard: MoodBoardInfo }>("/api/studio/direction-skill/restore", {});
      onMoodBoardChanged?.(r.moodBoard);
      toast.success(`${r.moodBoard.title} is back in the picker.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [savingDirection, setSavingDirection] = useState(false);

  async function saveDirection() {
    setSavingDirection(true);
    try {
      const r = await post<{ text: string }>("/api/studio/direction", { text: config.prompt });
      onDirectionSaved?.(r.text);
      toast.success("Saved as the default direction for everyone.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingDirection(false);
    }
  }

  async function savePreset() {
    if (!presetName.trim()) return;
    setSavingPreset(true);
    try {
      await post("/api/studio/presets", { name: presetName.trim(), config });
      setPresetName("");
      await onPresetsChanged?.();
      toast.success("Template saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingPreset(false);
    }
  }

  async function removePreset(id: string) {
    try {
      await del(`/api/studio/presets?id=${encodeURIComponent(id)}`);
      await onPresetsChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const enabled = models.filter((m) => m.enabled);
  const modelItems = enabled.length ? enabled.map((m) => m.slug) : [config.model || defaultModel];
  const modelLabel = (slug: string) => models.find((m) => m.slug === slug)?.name ?? slug;
  const realModelOnly = config.mode !== "1" && config.mode !== "6";

  return (
    <aside className="config-panel">
      <div className="panel-heading">
        <span className="step">01</span>
        <h2>Creative direction</h2>
        {canEdit && !editing && (
          <button
            className="icon-button"
            onClick={onEdit}
            aria-label="Edit batch settings"
            title="Edit batch settings"
          >
            <Pencil size={17} />
          </button>
        )}
      </div>
      {saved && !editing && (
        <p className="saved-note">
          Settings saved with this batch.{" "}
          {canEdit
            ? "Use the pencil to edit them for the remaining images."
            : "Pause the batch to edit them."}
        </p>
      )}
      {editing && (
        <div className="edit-bar">
          <span>
            Editing saved settings. Save, or press Generate, to apply them: queued images use them,
            finished images keep theirs.
          </span>
          <div className="footer-actions">
            <button className="primary" onClick={onSave} disabled={saving}>
              {saving ? <LoaderCircle className="spinning" size={15} /> : <Check size={15} />} Save
            </button>
            <button className="secondary" onClick={onCancel} disabled={saving}>
              <X size={15} /> Cancel
            </button>
          </div>
        </div>
      )}

      {!locked && (
        <div className="presets-box">
          <label className="field-label">Templates</label>
          {presets.length > 0 && (
            <ul>
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      const c = JSON.parse(p.config) as Config;
                      onChange({ ...c });
                      toast.success(`Template "${p.name}" applied.`);
                    }}
                  >
                    <Bookmark size={13} /> {p.name}
                  </button>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => void removePreset(p.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="footer-actions">
            <input
              className="text-input"
              placeholder="Save current settings as…"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => void savePreset()}
              disabled={savingPreset || !presetName.trim()}
            >
              {savingPreset ? (
                <LoaderCircle className="spinning" size={15} />
              ) : (
                <Bookmark size={15} />
              )}{" "}
              Save
            </button>
          </div>
        </div>
      )}

      <Section title="Model">
        <label className="field-label">AI model</label>
        <Picker
          value={config.model || defaultModel}
          label="AI model"
          disabled={locked}
          items={modelItems}
          render={modelLabel}
          onChange={(v) => onChange({ model: v })}
        />
        {models.some((m) => !m.enabled) && (
          <details className="prompt-details compact">
            <summary>{models.filter((m) => !m.enabled).length} models not available</summary>
            <div className="prompt-tip">
              {models
                .filter((m) => !m.enabled)
                .map((m) => `${m.name}${m.reason ? ` (${m.reason})` : ""}`)
                .join(", ")}
              . Add the vendor's key in Connection to enable them.
            </div>
          </details>
        )}

        {(config.model || defaultModel).startsWith("gemini") && (
          <div className="centering">
            <PiggyBank size={21} />
            <div>
              <strong>Economy mode</strong>
              <span>Google Flex tier · half price · delivery can take minutes to hours</span>
            </div>
            <Switch
              checked={config.economy}
              disabled={locked}
              onCheckedChange={(v) => onChange({ economy: v })}
              aria-label="Economy mode"
            />
          </div>
        )}
      </Section>

      <label className="field-label">Original photography</label>
      <Picker
        value={config.input}
        label="Source type"
        disabled={locked || realModelOnly}
        items={realModelOnly ? ["model"] : INPUT_TYPES}
        onChange={(v) => onChange({ input: v as Config["input"] })}
      />

      {config.mode === "6" && (
        <>
          <label className="field-label" htmlFor="colors">
            Background colours (comma-separated, one image each)
          </label>
          <input
            id="colors"
            className="text-input"
            disabled={locked}
            value={config.colors}
            onChange={(e) => onChange({ colors: e.target.value })}
            placeholder="pure white, warm beige, #F2E8DA"
          />
          <div className="prompt-tip">
            {backdropColors(config).length} colour{backdropColors(config).length > 1 ? "s" : ""}:{" "}
            {backdropColors(config).join(" · ")}
          </div>
        </>
      )}

      {config.mode !== "1" && config.mode !== "6" && (
        <>
          <label className="field-label">
            {config.mode === "4"
              ? "Backgrounds per original"
              : config.mode === "3"
                ? "Poses per original"
                : "Images per original"}
          </label>
          <Picker
            value={String(config.count)}
            label="Images per original"
            disabled={locked}
            items={COUNTS}
            onChange={(v) => onChange({ count: Number(v) })}
          />
        </>
      )}

      {usesBuilder(config.mode) && (
        <>
          <div className="field-row">
            <label className="field-label">Skill</label>
            <span className="field-row-actions">
              {currentSkill && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSkillEditor({ open: true, skill: currentSkill })}
                >
                  <Pencil size={13} /> Edit
                </button>
              )}
              {currentSkill && (isZaidEntry ? skills.length > 0 : skillList.length > 1) && (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => void deleteSkill()}
                >
                  <Trash2 size={13} /> Delete
                </button>
              )}
              {moodHidden && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void restoreMoodBoard()}
                >
                  <RotateCcw size={13} /> Restore {moodBoard?.title ?? "Mood board"}
                </button>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() => setSkillEditor({ open: true, skill: null })}
              >
                <Plus size={13} /> New skill
              </button>
            </span>
          </div>
          <div className="skills" role="radiogroup" aria-label="Skill">
            {skillList.map((s) => (
              <div
                key={s.id}
                className={`skill-card ${config.skill === s.id ? "active" : ""} ${dragId === s.id ? "dragging" : ""}`}
                draggable={!locked && s.id !== "zaid"}
                onDragStart={() => setDragId(s.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => void reorder(s.id)}
                onDragEnd={() => setDragId(null)}
                title="Drag to reorder"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={config.skill === s.id}
                  className="skill-pick"
                  disabled={locked}
                  onClick={() => onChange({ skill: s.id })}
                >
                  {s.thumb ? (
                    <img
                      className="skill-thumb"
                      src={`/api/studio/references/${s.thumb}/file`}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="skill-thumb placeholder" aria-hidden="true">
                      {s.title.slice(0, 1)}
                    </span>
                  )}
                  <strong>{s.title}</strong>
                  <span>{s.caption}</span>
                </button>
                {
                  <button
                    type="button"
                    className={`skill-star ${s.favourite ? "on" : ""}`}
                    aria-label={s.favourite ? "Remove from favourites" : "Add to favourites"}
                    aria-pressed={s.favourite}
                    onClick={() => void toggleFavourite(s)}
                  >
                    <Star size={14} fill={s.favourite ? "currentColor" : "none"} />
                  </button>
                }
              </div>
            ))}
          </div>
          {currentSkill && (
            <div className="prompt-tip">
              {currentSkill.description ||
                "Add reference photos: the skill writes itself from them."}
              {rebuilding && " Updating the skill text from its photos…"}
            </div>
          )}
          {currentSkill && (
            <div className="direction-choice">
              <label className="field-label">Direction for this skill</label>
              <div className="segmented" role="radiogroup" aria-label="Direction">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!config.look}
                  className={!config.look ? "on" : ""}
                  disabled={locked}
                  onClick={() => onChange({ look: undefined })}
                >
                  Reference photos
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!!config.look}
                  className={config.look ? "on" : ""}
                  disabled={locked || !skillLooks.length}
                  title={
                    skillLooks.length ? "" : "Save a prompt you like from the review dialog first"
                  }
                  onClick={() => onChange({ look: skillLooks[0]?.id })}
                >
                  Saved look{skillLooks.length ? ` (${skillLooks.length})` : ""}
                </button>
              </div>
              {config.look && (
                <div className="look-pick">
                  <div className="look-strip" role="radiogroup" aria-label="Saved looks">
                    {skillLooks.map((l) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={l.id === config.look}
                        key={l.id}
                        className={`look-card ${l.id === config.look ? "active" : ""}`}
                        disabled={locked}
                        onClick={() => onChange({ look: l.id })}
                        title={l.scene}
                      >
                        {l.image ? (
                          <img
                            className="look-thumb"
                            src={`/api/studio/looks/${l.id}/image`}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <span className="look-thumb placeholder" aria-hidden="true">
                            {l.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <strong>{l.name}</strong>
                      </button>
                    ))}
                  </div>
                  {currentLook && (
                    <p className="prompt-tip">
                      Same scene, pose and light every image: {currentLook.scene}
                      {currentLook.light ? ` · ${currentLook.light}` : ""}. Only the outfit and
                      framing follow each photo.
                    </p>
                  )}
                  {currentLook && !locked && (
                    <button
                      type="button"
                      className="text-button danger-text"
                      onClick={() => void deleteLook(currentLook)}
                    >
                      <Trash2 size={13} /> Delete this look
                    </button>
                  )}
                </div>
              )}
              {!config.look && (
                <p className="prompt-tip">
                  Each image borrows its scene from one of the reference photos below. Like a
                  result? Save its prompt as a look from the review dialog and reuse it here.
                </p>
              )}
            </div>
          )}
          {currentSkill && !config.look && (
            <Suspense fallback={null}>
              <ReferenceLibrary
                key={currentSkill.id}
                skill={currentSkill.id}
                title={isZaidEntry ? "Mood board" : `${currentSkill.title} reference library`}
                onChanged={libraryChanged}
              />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <SkillDialog
              open={skillEditor.open}
              skill={skillEditor.skill}
              onClose={() => setSkillEditor((e) => ({ ...e, open: false }))}
              onSaved={(list, id) => onSkillsChanged?.(list, id)}
              onMoodBoardSaved={(mb, direction) => {
                onMoodBoardChanged?.(mb);
                if (direction !== undefined) {
                  onDirectionSaved?.(direction);
                  if (!locked) onChange({ prompt: direction });
                }
              }}
            />
          </Suspense>

          {config.mode !== "7" && (
            <>
              <label className="field-label">
                Generated face (when the reference face is hidden)
              </label>
              <Picker
                value={config.market}
                label="Market look"
                disabled={locked}
                items={MARKETS}
                render={(v) =>
                  v === "auto"
                    ? "Auto (alternate Arab / European)"
                    : v === "arab"
                      ? "Arab / Middle-Eastern"
                      : v === "european"
                        ? "European"
                        : "Mixed"
                }
                onChange={(v) => onChange({ market: v as Config["market"] })}
              />
            </>
          )}
        </>
      )}

      {config.mode === "1" && (
        <>
          <label className="field-label" htmlFor="backdrop">
            Studio backdrop (cards 2-5)
          </label>
          <input
            id="backdrop"
            className="text-input"
            disabled={locked}
            value={config.backdrop}
            onChange={(e) => onChange({ backdrop: e.target.value })}
            placeholder="warm beige seamless paper backdrop"
          />
        </>
      )}

      {(config.mode === "1" || config.mode === "2") && (
        <>
          <label className="field-label" htmlFor="model-direction">
            Model direction
          </label>
          <textarea
            id="model-direction"
            disabled={locked}
            rows={2}
            value={config.modelDescription}
            onChange={(e) => onChange({ modelDescription: e.target.value })}
          />
        </>
      )}

      {config.mode === "9" && (
        <>
          <div className="prompt-tip">
            No prompt is written. Each image takes a background from the library below and a pose
            with the same framing as the upload. Both shots of a product share one background.
            Backgrounds should be clean plates without people, 2K or larger; poses work best as one
            person on a plain background.
          </div>
          <Suspense fallback={null}>
            <ReferenceLibrary skill="np-bg" title="Backgrounds" />
          </Suspense>
          <Suspense fallback={null}>
            <ReferenceLibrary skill="np-pose" title="Poses (full, ¾, upper or lower body)" />
          </Suspense>
        </>
      )}
      {config.mode !== "9" && (
        <>
          <div className="field-row">
            <label className="field-label" htmlFor="prompt">
              {config.mode === "4"
                ? "Background direction"
                : config.mode === "6"
                  ? "Extra instructions (optional)"
                  : isSkillCampaign(config.mode)
                    ? "Extra requests for this skill (optional)"
                    : config.mode === "7"
                      ? "Extra direction for this batch (optional)"
                      : "Background & lifestyle prompt"}
            </label>
            {config.mode === "7" ? (
              <span className="field-row-actions">
                <button
                  className="text-button"
                  disabled={locked || savingDirection || !config.prompt.trim()}
                  onClick={() => void saveDirection()}
                >
                  {savingDirection ? "Saving…" : "Save as default"}
                </button>
                <button
                  className="text-button"
                  disabled={locked}
                  onClick={() => onChange({ prompt: defaultDirection })}
                >
                  Reset
                </button>
              </span>
            ) : (
              <button
                className="text-button"
                disabled={locked}
                onClick={() => onChange({ prompt: DEFAULT_PROMPT })}
              >
                Reset
              </button>
            )}
          </div>
          <textarea
            id="prompt"
            className="prompt"
            value={config.prompt}
            disabled={locked}
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
          {!isSkillCampaign(config.mode) && config.mode !== "6" && config.mode !== "7" && (
            <div className="prompt-tip">
              Each image also gets one of the built-in scenes: {SCENES.slice(0, 2).join(" ")} …
            </div>
          )}
        </>
      )}

      {config.mode === "7" && (
        <Suspense fallback={null}>
          <DirectionRules locked={locked} />
        </Suspense>
      )}

      <div className="two-fields">
        <div>
          <label className="field-label">Frame</label>
          <Picker
            label="Aspect ratio"
            value={config.ratio}
            disabled={locked}
            items={RATIOS}
            onChange={(v) => onChange({ ratio: v as Config["ratio"] })}
          />
        </div>
        <div>
          <label className="field-label">Resolution</label>
          <Picker
            label="Resolution"
            value={config.size}
            disabled={locked}
            items={SIZES}
            onChange={(v) => onChange({ size: v as Config["size"] })}
          />
        </div>
      </div>

      <Section
        title="Export & checks"
        hint={`${config.output === "png" && config.outputSize !== "quality" ? "JPG" : config.output.toUpperCase()}${config.outputSize === "quality" ? (config.output === "png" ? " · as generated" : ` ${config.outputQuality}%`) : " · 1 to 1.9 MB"} · ProductID_0_N`}
        defaultOpen={false}
      >
        {config.mode !== "4" && config.mode !== "6" && (
          <>
            <div className="centering">
              <ScanLine size={21} />
              <div>
                <strong>Centre model</strong>
                <span>Check alignment · retry once if needed</span>
              </div>
              <Switch
                checked={config.center}
                disabled={locked}
                onCheckedChange={(v) => onChange({ center: v })}
                aria-label="Check model centering"
              />
            </div>
            <p className="quality-note">
              Alignment is checked only when automatic review is configured. Uncertain results are
              held for review. Extra attempts use additional credits.
            </p>
          </>
        )}

        <div className="two-fields">
          <div>
            <label className="field-label">Export format</label>
            <Picker
              label="Export format"
              value={config.output}
              disabled={locked}
              items={OUTPUT_FORMATS}
              render={(v) => v.toUpperCase()}
              onChange={(v) => onChange({ output: v as Config["output"] })}
            />
          </div>
          <div>
            <label className="field-label">Size per image</label>
            <Picker
              label="Size per image"
              value={config.outputSize ?? "fit"}
              disabled={locked}
              items={["fit", "quality"]}
              render={(v) =>
                v === "fit"
                  ? "1 to 1.9 MB"
                  : config.output === "png"
                    ? "As generated"
                    : "By quality"
              }
              onChange={(v) => onChange({ outputSize: v as Config["outputSize"] })}
            />
          </div>
        </div>
        {config.output !== "png" && config.outputSize !== "fit" && (
          <div className="two-fields">
            <div>
              <label className="field-label">Quality</label>
              <Picker
                label="Export quality"
                value={String(config.outputQuality)}
                disabled={locked}
                items={["100", "95", "90", "85", "80", "75"]}
                render={(v) => `${v}%`}
                onChange={(v) => onChange({ outputQuality: Number(v) })}
              />
            </div>
          </div>
        )}
        {config.output === "png" && (
          <p className="prompt-tip">
            {config.outputSize === "quality"
              ? "As generated: the engine's file is kept untouched, usually 3 to 10 MB. Choose 1 to 1.9 MB to fit every image at the full resolution (exported as JPG, since PNG cannot be sized without losing resolution)."
              : "PNG cannot be sized without lowering the resolution, so with 1 to 1.9 MB every image is exported as a JPG fitted at the full resolution. Choose As generated to keep the engine's file untouched."}
          </p>
        )}

        <div className="export-rule">
          <FileImage size={18} />
          <div>
            Product ID + <b>_0_</b> + image number
            <span>
              Example: 168761402_01.jpg → 168761402_0_1.{config.output}, 168761402_02.jpg →
              168761402_0_2.{config.output}
            </span>
          </div>
        </div>
      </Section>
    </aside>
  );
}

/** Collapsible group of settings; rarely changed groups start closed. */
function Section({
  title,
  hint,
  defaultOpen = true,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`panel-section ${open ? "open" : ""}`}>
      <button
        type="button"
        className="panel-section-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          {title}
          {hint && !open && <small>{hint}</small>}
        </span>
        <ChevronDown size={15} />
      </button>
      {open && <div className="panel-section-body">{children}</div>}
    </section>
  );
}
