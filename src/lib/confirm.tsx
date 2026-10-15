import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * An in-page confirm. The browser's own confirm() is silently blocked inside some embedded
 * browsers (it returns false without showing anything), so every destructive action asks here.
 */
export function askConfirm(
  message: string,
  { ok = "Remove", danger = true }: { ok?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(<ConfirmBox message={message} ok={ok} danger={danger} onDone={done} />);
  });
}

function ConfirmBox({
  message,
  ok,
  danger,
  onDone,
}: {
  message: string;
  ok: string;
  danger: boolean;
  onDone: (v: boolean) => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <div className="confirm-backdrop" onClick={() => onDone(false)}>
      <div
        className="confirm-box"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p>{message}</p>
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button
            ref={okRef}
            type="button"
            className={danger ? "secondary danger" : "primary"}
            onClick={() => onDone(true)}
          >
            {ok}
          </button>
        </div>
      </div>
    </div>
  );
}

/** An in-page prompt for one line of text; resolves null when cancelled. */
export function askInput(
  message: string,
  initial = "",
  { ok = "Save", placeholder = "" }: { ok?: string; placeholder?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(
      <InputBox message={message} initial={initial} ok={ok} placeholder={placeholder} onDone={done} />,
    );
  });
}

function InputBox({
  message,
  initial,
  ok,
  placeholder,
  onDone,
}: {
  message: string;
  initial: string;
  ok: string;
  placeholder: string;
  onDone: (v: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <div className="confirm-backdrop" onClick={() => onDone(null)}>
      <form
        className="confirm-box"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onDone(value);
        }}
      >
        <p>{message}</p>
        <input
          ref={input}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onDone(null)}
        />
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {ok}
          </button>
        </div>
      </form>
    </div>
  );
}
