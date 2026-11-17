import '@logseq/libs';
import type { BlockEntity } from '@logseq/libs/dist/LSPlugin.user';
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
 * Estimate the target block's vertical position ratio (0..1) on the page
 * by finding its position in the page's block tree.
 */
async function estimateBlockRatio(
  pageName: string,
  blockUuid: string
): Promise<number | null> {
  try {
    const tree = await logseq.Editor.getPageBlocksTree(pageName);
    if (!tree || tree.length === 0) return null;

    let total = 0;
    let foundIndex = -1;

    const walk = (nodes: BlockEntity[]) => {
      for (const node of nodes) {
        if (node.uuid === blockUuid) {
          foundIndex = total;
        }
        total++;
        if (node.children && node.children.length > 0) {
          walk(node.children as BlockEntity[]);
        }
      }
    };

    walk(tree);
    if (foundIndex < 0 || total <= 1) return null;
    return foundIndex / (total - 1);
  } catch {
    return null;
  }
}

/**
 * Navigate to `pageName` and jump directly to `blockUuid`.
 * If Logseq's lazy loader has not mounted the block yet, first tries a direct
 * ratio jump, then fast-loads remaining lazy chunks at the bottom sentinel
 * until the block appears, and snaps straight to it.
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

  opts.onStatus?.('Jumping to note...');
  await logseq.App.pushState('page', { name: pageName });
  await sleep(120);

  await expandBlockAncestors(blockUuid);
  await nextFrame(doc);

  const container = findMainScrollContainer(doc);
  if (!container) {
    await logseq.Editor.scrollToBlockInPage(pageName, blockUuid);
    return false;
  }

  // 1. Check if already rendered in the DOM
  let target = findBlockElement(doc, blockUuid);
  if (target) {
    await centerAndHighlight(doc, target);
    return true;
  }

  // 2. Direct ratio jump: jump straight to the estimated position on the page
  const ratio = await estimateBlockRatio(pageName, blockUuid);
  if (ratio !== null) {
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.floor(maxScroll * ratio);
    await nextFrame(doc);
    await sleep(60);

    target = findBlockElement(doc, blockUuid);
    if (target) {
      await centerAndHighlight(doc, target);
      return true;
    }
  }

  // 3. Fast sequential sentinel trigger: jump directly to the bottom of the
  //    currently loaded content on each tick so lazy-loaded chunks mount as fast as possible.
  let stagnantCount = 0;
  for (let step = 0; step < 120; step++) {
    target = findBlockElement(doc, blockUuid);
    if (target) {
      await centerAndHighlight(doc, target);
      return true;
    }

    const prevHeight = container.scrollHeight;
    container.scrollTop = container.scrollHeight;
    await nextFrame(doc);
    await sleep(25);

    target = findBlockElement(doc, blockUuid);
    if (target) {
      await centerAndHighlight(doc, target);
      return true;
    }

    if (container.scrollHeight === prevHeight) {
      stagnantCount++;
      if (stagnantCount >= 4) break;
      await sleep(50);
    } else {
      stagnantCount = 0;
    }
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
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  await nextFrame(doc);
  await sleep(120);
  // Re-center once in case newly mounted blocks shifted layout heights
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

  let stagnant = 0;
  for (let i = 0; i < 150; i++) {
    const prevHeight = container.scrollHeight;
    container.scrollTop = container.scrollHeight;
    await nextFrame(doc);
    await sleep(25);

    if (container.scrollHeight === prevHeight) {
      stagnant++;
      if (stagnant >= 4) break;
      await sleep(50);
    } else {
      stagnant = 0;
    }
  }

  container.scrollTop = originalTop;
  await logseq.UI.showMsg('Finished loading all page blocks.', 'success');
}
