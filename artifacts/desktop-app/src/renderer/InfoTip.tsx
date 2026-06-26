import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  label?: string;
  children: ReactNode;
}

const CONTENT_WIDTH = 340;
const VIEWPORT_MARGIN = 12;

export default function InfoTip({ label = "More information", children }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function isInside(target: Node): boolean {
      if (triggerRef.current?.contains(target)) return true;
      return target instanceof Element && target.closest(".info-tip__portal") != null;
    }
    function onClickOutside(event: MouseEvent) {
      if (!isInside(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(CONTENT_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      // Anchored to the trigger's own viewport rect (not a CSS-relative
      // offset), then clamped within the viewport, so the popup can never run
      // off-screen or be clipped by an ancestor card's overflow.
      const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN);
      setPosition({ top: rect.bottom + 8, left, width });
    }
    setOpen(true);
  }

  return (
    <div className="info-tip">
      <button
        type="button"
        ref={triggerRef}
        className="info-tip__trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={toggleOpen}
      >
        i
      </button>
      {open && position && createPortal(
        <div
          className="info-tip__content info-tip__portal"
          style={{ position: "fixed", top: position.top, left: position.left, width: position.width }}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
