import { useEffect, type ReactNode } from 'react';

/** A panel that slides up from the bottom, the usual shape for choices on a phone. */
export function Sheet(props: { title: string; onClose: () => void; children: ReactNode }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{props.title}</h2>
          <button className="btn-quiet" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
