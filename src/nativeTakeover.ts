import '@logseq/libs';
import { findBlockUuidBySnippet } from './search';
import { findBlockElement, highlightBlockElement, jumpToBlock } from './scroller';

interface PendingJump {
  blockUuid?: string;
  snippet: string;
  pageHint?: string;
  createdAt: number;
}

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let pending: PendingJump | null = null;
let rescuing = false;

function getHostDocument(): Document | null {
  try {
    return window.parent?.document ?? null;
  } catch {
    return null;
  }
}

function isInNativeSearchModal(el: Element | null): HTMLElement | null {
  if (!el) return null;
  const known = el.closest<HTMLElement>(
    '.cp__palette-main, .ls-search, .ui__modal, .ui__modal-panel, .ls-modal, [role="dialog"]'
  );
  if (known) return known;

  // Fallback: check if inside any modal/overlay that contains a search input
  let cur: HTMLElement | null = el as HTMLElement;
  while (cur && cur !== cur.ownerDocument.body) {
    const style = cur.ownerDocument.defaultView?.getComputedStyle(cur);
    if (
      style &&
      (style.position === 'fixed' || style.position === 'absolute') &&
      cur.querySelector('input')
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

function findResultRow(target: Element | null, modal: HTMLElement): HTMLElement | null {
  if (!target) return null;
  const row = target.closest<HTMLElement>(
    '.menu-item, .chosen, [role="option"], a[href], li, [data-id]'
  );
  if (row && modal.contains(row)) return row;

  // Fallback: walk up to a direct child of a scrollable list inside the modal
  let cur: HTMLElement | null = target as HTMLElement;
  while (cur && cur.parentElement && modal.contains(cur.parentElement)) {
    if (cur.parentElement.children.length > 1 && cur.tagName !== 'INPUT') {
      const text = (cur.innerText || '').trim();
      if (text.length > 0 && cur.parentElement !== modal) {
        return cur;
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

function extractFromRow(row: HTMLElement): PendingJump | null {
  const attrCandidates = [
    row.getAttribute('data-id'),
    row.getAttribute('blockid'),
    row.getAttribute('href'),
    row.querySelector('[href]')?.getAttribute('href'),
    row.querySelector('[blockid]')?.getAttribute('blockid'),
    row.outerHTML,
  ];

  let blockUuid: string | undefined;
  for (const cand of attrCandidates) {
    if (!cand) continue;
    const m = cand.match(UUID_REGEX);
    if (m) {
      blockUuid = m[0];
      break;
    }
  }

  const rawText = (row.innerText || row.textContent || '').trim();
  if (!rawText && !blockUuid) return null;

  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (
    lines[0]?.startsWith('Create page') ||
    lines[0]?.startsWith('Create whiteboard')
  ) {
    return null;
  }

  const pageHint = lines.length > 1 ? lines[0] : undefined;
  const snippet = lines.length > 1 ? lines.slice(1).join(' ') : lines[0] ?? '';

  console.log('[Deep Jump] Captured native search click:', {
    blockUuid,
    pageHint,
    snippet,
  });

  return {
    blockUuid,
    snippet,
    pageHint,
    createdAt: Date.now(),
  };
}

function isElementInViewport(doc: Document, el: HTMLElement): boolean {
  const win = doc.defaultView ?? window;
  const rect = el.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= win.innerHeight;
}

async function processPendingJump(routePath?: string): Promise<void> {
  if (!pending || rescuing) return;
  const current = pending;
  if (Date.now() - current.createdAt > 6000) {
    pending = null;
    return;
  }
  pending = null;
  rescuing = true;

  try {
    // Allow Logseq to finish rendering the target page route
    await new Promise((r) => window.setTimeout(r, 450));

    const doc = getHostDocument();
    const page = await logseq.Editor.getCurrentPage();
    let pageName =
      page && 'name' in page ? String(page.name) : undefined;

    if (!pageName && routePath) {
      const m = routePath.match(/^\/page\/(.+)$/);
      if (m) pageName = decodeURIComponent(m[1]);
    }
    if (!pageName) {
      pageName = current.pageHint;
    }

    if (!pageName) {
      console.log('[Deep Jump] Could not resolve target page name');
      return;
    }

    const targetUuid =
      current.blockUuid ??
      (current.snippet
        ? await findBlockUuidBySnippet(pageName, current.snippet)
        : null);

    console.log('[Deep Jump] Resolved target:', { pageName, targetUuid });
    if (!targetUuid) return;

    if (doc) {
      const existing = findBlockElement(doc, targetUuid);
      if (existing && isElementInViewport(doc, existing)) {
        highlightBlockElement(doc, existing);
        return;
      }
    }

    await jumpToBlock(pageName, targetUuid, {
      onStatus: (msg) => {
        void logseq.UI.showMsg(msg, 'info', { timeout: 1400 });
      },
    });
  } catch (err) {
    console.error('[Deep Jump] Native takeover error:', err);
  } finally {
    rescuing = false;
  }
}

export function installNativeSearchTakeover(): () => void {
  const doc = getHostDocument();
  if (!doc) {
    console.warn('[Deep Jump] Cannot access parent.document');
    return () => {};
  }

  const onPointerDown = (ev: PointerEvent) => {
    if (logseq.settings?.autoRescueNavigation === false) return;
    if (ev.shiftKey) return;

    const target = ev.target as Element | null;
    const modal = isInNativeSearchModal(target);
    if (!modal) return;

    const row = findResultRow(target, modal);
    if (!row) return;

    const extracted = extractFromRow(row);
    if (extracted) {
      pending = extracted;
      window.setTimeout(() => void processPendingJump(), 200);
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (logseq.settings?.autoRescueNavigation === false) return;
    if (ev.key !== 'Enter' || ev.shiftKey) return;

    const active = doc.activeElement as Element | null;
    const modal = isInNativeSearchModal(active);
    if (!modal) return;

    const selectedRow =
      modal.querySelector<HTMLElement>(
        '.menu-item.chosen, .chosen, [aria-selected="true"]'
      ) ?? findResultRow(active, modal);

    if (!selectedRow) return;

    const extracted = extractFromRow(selectedRow);
    if (extracted) {
      pending = extracted;
      window.setTimeout(() => void processPendingJump(), 200);
    }
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);

  const offRoute = logseq.App.onRouteChanged((ev) => {
    if (pending) {
      void processPendingJump(ev.path);
    }
  });

  console.log('[Deep Jump] Native search takeover installed');

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    if (typeof offRoute === 'function') offRoute();
  };
}
