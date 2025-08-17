export function shouldInjectError(tag: string): boolean {
  try {
    const w = window as unknown as { __INJECT_ERR?: string };
    const fromWin = w.__INJECT_ERR;
    const fromLS = localStorage.getItem('inject_err') || undefined;
    const fromQuery = typeof window !== 'undefined' && window.location
      ? new URLSearchParams(window.location.search).get('inject_err') || undefined
      : undefined;
    return [fromWin, fromLS, fromQuery].includes(tag);
  } catch {
    return false;
  }
}

