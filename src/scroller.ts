import '@logseq/libs';
import { expandBlockAncestors } from './search';

export interface JumpOptions {
  openInSidebar?: boolean;
  onStatus?: (msg: string) => void;
}

const HIGHLIGHT_STYLE_ID = 'deep-jump-highlight-style';

function getHostDocument(): Document | null {
  try {
    return window.parent?.document ?? null;
  } catch {
    return null;
  }
}

export function findBlockElement(doc: Document, blockUuid: string): HTMLElement | null {
  const escaped = CSS.escape(blockUuid);
  return (
    doc.querySelector<HTMLElement>(`[blockid="${escaped}"]`) ??
    doc.querySelector<HTMLElement>(`#block-content-${escaped}`)
  );
}

export function findMainScrollContainer(doc: Document): HTMLElement | null {
  return (
    doc.getElementById('main-content-container') ??
    doc.querySelector<HTMLElement>('.cp__sidebar-main-content') ??
    doc.documentElement
  );
}

function ensureHighlightStyles(doc: Document): void {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .deep-jump-target-highlight {
      outline: 2px solid var(--ls-link-text-color, #3b82f6) !important;
      outline-offset: 2px;
      background-color: rgba(59, 130, 246, 0.14) !important;
      border-radius: 4px;
      transition: background-color 0.4s ease, outline-color 0.4s ease;
    }
  `;
  doc.head.appendChild(style);
}

export function highlightBlockElement(doc: Document, el: HTMLElement): void {
  ensureHighlightStyles(doc);
  el.classList.add('deep-jump-target-highlight');
  window.setTimeout(() => {
    el.classList.remove('deep-jump-target-highlight');
  }, 2600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame(doc: Document): Promise<void> {
  const win = doc.defaultView ?? window;
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

/**
 * Navigate to `pageName` and force-scroll until `blockUuid` is rendered in the DOM,
 * then center and highlight it.
 */
export async function jumpToBlock(
  pageName: string,
  blockUuid: string,
  opts: JumpOptions = {}
): Promise<boolean> {
  if (opts.openInSidebar) {
    logseq.Editor.openInRightSidebar(blockUuid);
    return true;
  }

  const doc = getHostDocument();
  if (!doc) {
    await logseq.Editor.scrollToBlockInPage(pageName, blockUuid);
    return false;
  }

  opts.onStatus?.('Navigating to page...');
  await logseq.App.pushState('page', { name: pageName });
  await sleep(160);

  opts.onStatus?.('Expanding collapsed parent blocks...');
  await expandBlockAncestors(blockUuid);
  await sleep(100);

  const container = findMainScrollContainer(doc);
  if (!container) {
    await logseq.Editor.scrollToBlockInPage(pageName, blockUuid);
    return false;
  }

  // Check if already rendered in the DOM
  let target = findBlockElement(doc, blockUuid);
  if (target) {
    await centerAndHighlight(doc, target);
    return true;
  }

  // Start from the top and progressively scroll down to trigger lazy-loading
  opts.onStatus?.('Loading page blocks and scanning...');
  container.scrollTop = 0;
  await nextFrame(doc);
  await sleep(80);

  const maxSteps = 180;
  let stagnantCount = 0;
  let lastScrollTop = -1;

  for (let step = 0; step < maxSteps; step++) {
    target = findBlockElement(doc, blockUuid);
    if (target) {
      await centerAndHighlight(doc, target);
      return true;
    }

    const stepSize = Math.max(300, Math.floor(container.clientHeight * 0.85));
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

    if (container.scrollTop >= maxScroll - 2) {
      // Wait one more beat for any pending lazy-load batch at the bottom
      await sleep(140);
      target = findBlockElement(doc, blockUuid);
      if (target) {
        await centerAndHighlight(doc, target);
        return true;
      }

      if (container.scrollHeight - container.clientHeight <= maxScroll + 2) {
        stagnantCount++;
        if (stagnantCount >= 3) break;
      } else {
        stagnantCount = 0;
      }
    }

    lastScrollTop = container.scrollTop;
    container.scrollTop = Math.min(
      container.scrollTop + stepSize,
      container.scrollHeight
    );

    if (container.scrollTop === lastScrollTop) {
      stagnantCount++;
      if (stagnantCount >= 3) break;
    } else {
      stagnantCount = 0;
    }

    await nextFrame(doc);
    await sleep(75);
  }

  // Final check before fallback
  target = findBlockElement(doc, blockUuid);
  if (target) {
    await centerAndHighlight(doc, target);
    return true;
  }

  // Fallback: open in Right Sidebar so the user is never stranded
  logseq.Editor.openInRightSidebar(blockUuid);
  await logseq.UI.showMsg(
    'Block was not mounted in main view; opened in Right Sidebar instead.',
    'warning'
  );
  return false;
}

async function centerAndHighlight(doc: Document, el: HTMLElement): Promise<void> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(260);
  // Re-center once in case lazy-loaded content above shifted layout heights
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  highlightBlockElement(doc, el);
}

/**
 * Progressively scroll through the entire current page to force Logseq's lazy loader
 * to mount all blocks into the DOM (making native Ctrl+F work on the full page).
 */
export async function forceLoadEntirePage(): Promise<void> {
  const doc = getHostDocument();
  if (!doc) return;

  const container = findMainScrollContainer(doc);
  if (!container) return;

  const originalTop = container.scrollTop;
  await logseq.UI.showMsg('Loading all blocks on this page...', 'info');

  container.scrollTop = 0;
  await sleep(80);

  let stagnant = 0;
  for (let i = 0; i < 200; i++) {
    const prevHeight = container.scrollHeight;
    const stepSize = Math.max(350, Math.floor(container.clientHeight * 0.9));
    container.scrollTop += stepSize;
    await nextFrame(doc);
    await sleep(65);

    const atBottom =
      container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    if (atBottom && container.scrollHeight === prevHeight) {
      stagnant++;
      if (stagnant >= 3) break;
    } else {
      stagnant = 0;
    }
  }

  container.scrollTop = originalTop;
  await logseq.UI.showMsg('Finished loading all page blocks.', 'success');
}
