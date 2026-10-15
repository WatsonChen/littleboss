// Stopgap access token (until Google sign-in). Browser storage can be missing or blocked, so every
// access is guarded and the token falls back to memory for the current tab.
const KEY = 'littleboss.token';
let memory: string | null = null;

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setToken(token: string | null): void {
  memory = token;
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* keep the in-memory copy */
  }
}
