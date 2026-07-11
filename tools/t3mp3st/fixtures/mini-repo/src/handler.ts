// Intentionally weak sample for offline swarm fixture tests (not production).
export function handleInput(userHtml: string) {
  const el = document.createElement('div');
  el.innerHTML = userHtml;
  return el.textContent;
}
