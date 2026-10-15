import { useState } from 'react';

/** Asks for the access password (a stopgap until Google sign-in). */
export function TokenGate(props: { onSubmit: (token: string) => void; wrong: boolean }) {
  const [value, setValue] = useState('');
  return (
    <main className="page narrow">
      <h1>little boss</h1>
      <p className="muted">請輸入存取密碼。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) props.onSubmit(value.trim());
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="存取密碼"
        />
        {props.wrong && <p className="error-text">密碼不正確，請再試一次。</p>}
        <button className="btn-primary" type="submit" disabled={!value.trim()}>
          進入
        </button>
      </form>
    </main>
  );
}
