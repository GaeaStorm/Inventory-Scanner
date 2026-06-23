import { useState, type InputHTMLAttributes } from "react";

export default function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);

  return <span className="password-input">
    <input {...props} type={visible ? "text" : "password"} />
    <button
      className="password-input__toggle"
      type="button"
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      onClick={() => setVisible((value) => !value)}
    >
      {visible
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 5 9 5a15 15 0 0 1-2.2 2.7M6.6 6.6A15.5 15.5 0 0 0 3 12s3.5 5 9 5c1 0 2-.2 2.8-.5" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2.5" /></svg>}
    </button>
  </span>;
}
