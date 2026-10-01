// Private module state: never exposed through page globals or window messages.
export const widgetRuntime = {};
export function configureWidgetRuntime(value) { Object.assign(widgetRuntime, value); }
export function widgetStorage() {
  return widgetRuntime.storage || (typeof window !== 'undefined' ? window.localStorage : null);
}
export async function widgetFetch(url, options = {}) {
  if (!widgetRuntime.request) return fetch(url, options);
  const reply = await widgetRuntime.request(url, options);
  if (!reply?.ok) throw new Error(reply?.error || 'Extension API request failed');
  const bytes = Uint8Array.from(atob(reply.body), c => c.charCodeAt(0));
  return new Response([204, 205, 304].includes(reply.status) ? null : bytes, { status: reply.status, headers: reply.headers });
}
