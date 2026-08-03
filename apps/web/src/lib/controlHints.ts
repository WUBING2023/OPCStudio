const INTERACTIVE_SELECTOR = "button, [role='button'], input[type='button'], input[type='submit']";

function compactText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function deriveControlHint(element: Element): string | null {
  const explicit = compactText(element.getAttribute("data-tooltip"));
  if (explicit) return explicit;
  const aria = compactText(element.getAttribute("aria-label"));
  if (aria) return aria;
  const text = compactText(element.textContent);
  if (text && text.length <= 120) return text;
  return null;
}

export function applyControlHints(root: ParentNode): void {
  const elements: Element[] = [];
  if (root instanceof Element && root.matches(INTERACTIVE_SELECTOR)) elements.push(root);
  elements.push(...root.querySelectorAll(INTERACTIVE_SELECTOR));
  for (const element of elements) {
    if (element.hasAttribute("title")) continue;
    const hint = deriveControlHint(element);
    if (hint) element.setAttribute("title", hint);
  }
}

/** Adds native hover descriptions to lazily mounted controls without layout changes. */
export function observeControlHints(doc: Document = document): () => void {
  applyControlHints(doc);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) applyControlHints(node);
      }
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}