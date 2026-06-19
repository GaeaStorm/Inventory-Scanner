import type { ReactNode } from "react";

interface Props {
  label?: string;
  children: ReactNode;
}

export default function InfoTip({ label = "More information", children }: Props) {
  return (
    <details className="info-tip">
      <summary aria-label={label} title={label}>i</summary>
      <div className="info-tip__content">{children}</div>
    </details>
  );
}
