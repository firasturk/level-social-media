import { useEffect, useRef, useState } from "react";
import { askConfirm } from "@/lib/confirm";
import { ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { del, get, put } from "@/api";
import { Switch } from "@/components/ui/switch";
import type { DirectionRule } from "@shared/direction-rules";

/**
 * The fixed rules every Creative direction prompt follows. The team reads them here, switches
 * them off, edits the wording, adds and removes rules; every change is saved and used by the
 * next prompt written.
 */
export default function DirectionRules({ locked = false }: { locked?: boolean }) {
  const [rules, setRules] = useState<DirectionRule[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<DirectionRule[] | null>(null);

  useEffect(() => {
    get<{ rules: DirectionRule[] }>("/api/studio/direction-rules")
      .then((d) => setRules(d.rules))
      .catch((e) => toast.error((e as Error).message));
  }, []);

  // Edits are saved a moment after typing stops; switches, additions and removals save at once.
  function save(next: DirectionRule[], immediate = false) {
    setRules(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    const flush = async () => {
      const list = pending.current;
      if (!list) return;
      pending.current = null;
      setSaving(true);
      try {
        await put("/api/studio/direction-rules", {
          rules: list.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text),
        });
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSaving(false);
      }
    };
    if (immediate) void flush();
    else timer.current = window.setTimeout(() => void flush(), 700);
  }

  function update(i: number, patch: Partial<DirectionRule>, immediate = false) {
    if (!rules) return;
    save(
      rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
      immediate,
    );
  }

  function add() {
    if (!rules) return;
    const n = rules.filter((r) => r.key.startsWith("custom-")).length + 1;
    save([...rules, { key: `custom-${Date.now()}-${n}`, title: "", text: "", enabled: true }]);
  }

  async function remove(i: number) {
    if (!rules) return;
    const r = rules[i];
    if (r.text.trim() && !(await askConfirm(`Remove the rule "${r.title || r.text.slice(0, 40)}"?`)))
      return;
    save(
      rules.filter((_, j) => j !== i),
      true,
    );
  }

  async function reset() {
    if (
      !(await askConfirm(
        "Restore the original 13 rules exactly as they were? Your edits, switched-off rules and added rules are discarded.",
        { ok: "Restore" },
      ))
    )
      return;
    try {
      const d = await del<{ rules: DirectionRule[] }>("/api/studio/direction-rules");
      setRules(d.rules);
      toast.success("The original 13 rules are back.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const active = rules?.filter((r) => r.enabled && r.text.trim()).length ?? 0;

  return (
    <section className={`panel-section rules-section ${open ? "open" : ""}`}>
      <button
        type="button"
        className="panel-section-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          Fixed rules
          {!open && rules && (
            <small>
              {active} of {rules.length} on · every prompt follows them
            </small>
          )}
        </span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="panel-section-body">
          <p className="prompt-tip rules-tip">
            These rules are given to the prompt writer on every Creative direction image and
            override the skill, its template and the mood board. Switch one off, change its wording
            or add your own; the next prompt written uses the list as it is here. "Restore original
            rules" puts the 13 built-in rules back and discards your changes.
            {saving ? " Saving…" : ""}
          </p>
          {rules === null ? (
            <p className="prompt-tip">Loading…</p>
          ) : (
            <ol className="rules-list">
              {rules.map((r, i) => (
                <li key={r.key} className={r.enabled ? "" : "off"}>
                  <div className="rule-head">
                    <span className="rule-number">{i + 1}</span>
                    <input
                      className="rule-title"
                      value={r.title}
                      placeholder="Rule name"
                      disabled={locked}
                      onChange={(e) => update(i, { title: e.target.value })}
                    />
                    <Switch
                      checked={r.enabled}
                      disabled={locked}
                      onCheckedChange={(v) => update(i, { enabled: v }, true)}
                      aria-label="Rule on or off"
                    />
                    <button
                      type="button"
                      className="text-button danger-text"
                      disabled={locked}
                      aria-label="Remove rule"
                      onClick={() => void remove(i)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <textarea
                    className="rule-text"
                    value={r.text}
                    placeholder="What every prompt must do, written for the prompt writer."
                    disabled={locked}
                    onChange={(e) => update(i, { text: e.target.value })}
                  />
                </li>
              ))}
            </ol>
          )}
          <div className="field-row-actions rules-actions">
            <button type="button" className="text-button" disabled={locked} onClick={add}>
              <Plus size={13} /> Add rule
            </button>
            <button
              type="button"
              className="text-button"
              disabled={locked}
              title="Put the original 13 rules back and discard your edits and added rules"
              onClick={() => void reset()}
            >
              <RotateCcw size={13} /> Restore original rules
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
