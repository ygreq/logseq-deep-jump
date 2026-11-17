import '@logseq/libs';
import { searchBlocks, type SearchResult } from './search';
import { jumpToBlock } from './scroller';

const MODAL_ID = 'deep-jump-modal-overlay';
const STYLE_ID = 'deep-jump-modal-style';

function getHostDocument(): Document {
  return window.parent?.document ?? document;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMatches(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (terms.length === 0) return escaped;
  const regex = new RegExp(`(${terms.join('|')})`, 'gi');
  return escaped.replace(regex, '<mark class="dj-mark">$1</mark>');
}

function ensureModalStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${MODAL_ID} {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 10vh;
      font-family: var(--ls-font-family, system-ui, -apple-system, sans-serif);
    }
    .dj-dialog {
      width: min(680px, 92vw);
      max-height: 74vh;
      display: flex;
      flex-direction: column;
      background: var(--ls-primary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #111827);
      border: 1px solid var(--ls-border-color, #d1d5db);
      border-radius: 10px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      overflow: hidden;
    }
    .dj-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--ls-border-color, #e5e7eb);
      background: var(--ls-secondary-background-color, #f9fafb);
    }
    .dj-input {
      flex: 1;
      border: none;
      outline: none;
      background: transparent;
      color: inherit;
      font-size: 15px;
    }
    .dj-scope-btn {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--ls-border-color, #d1d5db);
      background: var(--ls-primary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #374151);
      cursor: pointer;
      white-space: nowrap;
    }
    .dj-scope-btn.active {
      background: var(--ls-link-text-color, #2563eb);
      color: #ffffff;
      border-color: transparent;
    }
    .dj-status {
      font-size: 12px;
      padding: 6px 14px;
      color: var(--ls-secondary-text-color, #6b7280);
      border-bottom: 1px solid var(--ls-border-color, #e5e7eb);
    }
    .dj-list {
      list-style: none;
      margin: 0;
      padding: 6px;
      overflow-y: auto;
      flex: 1;
    }
    .dj-item {
      padding: 9px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .dj-item.selected,
    .dj-item:hover {
      background: var(--ls-tertiary-background-color, rgba(59, 130, 246, 0.12));
    }
    .dj-page {
      font-size: 11px;
      font-weight: 600;
      color: var(--ls-link-text-color, #2563eb);
    }
    .dj-content {
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .dj-mark {
      background: rgba(250, 204, 21, 0.45);
      color: inherit;
      border-radius: 2px;
      padding: 0 2px;
    }
    .dj-footer {
      display: flex;
      justify-content: space-between;
      padding: 7px 14px;
      font-size: 11px;
      color: var(--ls-secondary-text-color, #6b7280);
      border-top: 1px solid var(--ls-border-color, #e5e7eb);
      background: var(--ls-secondary-background-color, #f9fafb);
    }
  `;
  doc.head.appendChild(style);
}

export function closeSearchModal(): void {
  const doc = getHostDocument();
  doc.getElementById(MODAL_ID)?.remove();
}

export async function openSearchModal(defaultCurrentPageOnly = false): Promise<void> {
  const doc = getHostDocument();
  ensureModalStyles(doc);
  closeSearchModal();

  const currentPage = await logseq.Editor.getCurrentPage();
  const currentPageName =
    currentPage && 'name' in currentPage ? String(currentPage.name) : undefined;

  let currentPageOnly = defaultCurrentPageOnly && Boolean(currentPageName);
  let results: SearchResult[] = [];
  let selectedIndex = 0;
  let debounceTimer: number | undefined;

  const overlay = doc.createElement('div');
  overlay.id = MODAL_ID;
  overlay.innerHTML = `
    <div class="dj-dialog" role="dialog" aria-modal="true" aria-label="Deep Jump Search">
      <div class="dj-header">
        <input class="dj-input" type="text" placeholder="Search notes (multi-word supported)..." />
        <button class="dj-scope-btn ${currentPageOnly ? 'active' : ''}" type="button" ${
          currentPageName ? '' : 'disabled title="No active page"'
        }>
          ${currentPageOnly ? 'Current Page' : 'All Pages'}
        </button>
      </div>
      <div class="dj-status">Type to search blocks...</div>
      <ul class="dj-list"></ul>
      <div class="dj-footer">
        <span>Enter: Jump &amp; Force-Scroll &nbsp;|&nbsp; Shift+Enter: Right Sidebar</span>
        <span>Esc: Close</span>
      </div>
    </div>
  `;

  doc.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>('.dj-input')!;
  const scopeBtn = overlay.querySelector<HTMLButtonElement>('.dj-scope-btn')!;
  const statusEl = overlay.querySelector<HTMLDivElement>('.dj-status')!;
  const listEl = overlay.querySelector<HTMLUListElement>('.dj-list')!;

  const renderList = () => {
    listEl.innerHTML = '';
    const query = input.value;

    results.forEach((item, idx) => {
      const li = doc.createElement('li');
      li.className = `dj-item${idx === selectedIndex ? ' selected' : ''}`;
      li.innerHTML = `
        <span class="dj-page">${escapeHtml(item.originalName)}</span>
        <span class="dj-content">${highlightMatches(item.content, query)}</span>
      `;
      li.addEventListener('click', (ev) => {
        void executeJump(item, ev.shiftKey);
      });
      listEl.appendChild(li);
    });

    const active = listEl.children[selectedIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  };

  const runSearch = async () => {
    const q = input.value.trim();
    if (!q) {
      results = [];
      selectedIndex = 0;
      statusEl.textContent = 'Type to search blocks...';
      renderList();
      return;
    }

    statusEl.textContent = 'Searching...';
    const scopePage = currentPageOnly ? currentPageName : undefined;
    try {
      results = await searchBlocks(q, scopePage);
      selectedIndex = 0;
      statusEl.textContent =
        results.length === 0
          ? 'No matching blocks found.'
          : `Found ${results.length}${results.length >= 80 ? '+' : ''} block(s)`;
      renderList();
    } catch (err) {
      console.error('[Deep Jump] Search failed:', err);
      results = [];
      statusEl.textContent = `Search error: ${err instanceof Error ? err.message : String(err)}`;
      renderList();
    }
  };

  const executeJump = async (item: SearchResult, openInSidebar: boolean) => {
    closeSearchModal();
    await jumpToBlock(item.pageName, item.uuid, {
      openInSidebar,
      onStatus: (msg) => {
        void logseq.UI.showMsg(msg, 'info', { timeout: 1500 });
      },
    });
  };

  scopeBtn.addEventListener('click', () => {
    if (!currentPageName) return;
    currentPageOnly = !currentPageOnly;
    scopeBtn.classList.toggle('active', currentPageOnly);
    scopeBtn.textContent = currentPageOnly ? 'Current Page' : 'All Pages';
    void runSearch();
    input.focus();
  });

  input.addEventListener('input', () => {
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void runSearch(), 150);
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeSearchModal();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex + 1) % results.length;
        renderList();
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        renderList();
      }
    } else if (ev.key === 'Enter' && results[selectedIndex]) {
      ev.preventDefault();
      void executeJump(results[selectedIndex], ev.shiftKey);
    }
  });

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeSearchModal();
  });

  input.focus();
}
