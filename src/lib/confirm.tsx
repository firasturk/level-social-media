import { useEffect, useRef } from "react";
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
