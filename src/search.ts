import '@logseq/libs';
import type { BlockEntity, PageEntity } from '@logseq/libs/dist/LSPlugin.user';

export interface SearchResult {
  uuid: string;
  content: string;
  pageName: string;
  originalName: string;
  isJournal: boolean;
  journalDay?: number;
}

const pageCache = new Map<number, PageEntity>();

async function resolvePage(pageId: number): Promise<PageEntity | null> {
  const cached = pageCache.get(pageId);
  if (cached) return cached;
  const page = await logseq.Editor.getPage(pageId);
  if (page) {
    pageCache.set(pageId, page);
  }
  return page;
}

/**
 * Search blocks using Logseq's native query engine (`logseq.DB.q`),
 * which is much faster and more reliable than scanning all blocks in DataScript.
 */
export async function searchBlocks(
  rawQuery: string,
  onlyPageName?: string,
  limit = 80
): Promise<SearchResult[]> {
  const terms = rawQuery
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return [];
  }

  // Fast path: when scoped to a single page, search its block tree directly
  if (onlyPageName) {
    return searchInSinglePage(onlyPageName, terms, limit);
  }

  // Build a Logseq simple query: (and "term1" "term2" ...)
  // Strip leading '#' so "#aiNews" matches both tag references and plain text.
  const clauses = terms.map((t) => {
    const normalized = t.startsWith('#') && t.length > 1 ? t.slice(1) : t;
    return `"${escapeQueryString(normalized)}"`;
  });
  const dsl = clauses.length === 1 ? clauses[0] : `(and ${clauses.join(' ')})`;

  const blocks = (await logseq.DB.q<BlockEntity>(dsl)) ?? [];
  const results: SearchResult[] = [];

  for (const block of blocks) {
    if (!block?.uuid || !block.content) continue;
    const pageId = block.page?.id;
    let pageName = block.page?.name ? String(block.page.name) : '';
    let originalName = block.page?.originalName
      ? String(block.page.originalName)
      : pageName;
    let isJournal = Boolean(block.page?.['journal?']);
    let journalDay =
      typeof block.page?.journalDay === 'number'
        ? block.page.journalDay
        : undefined;

    if ((!pageName || !originalName) && typeof pageId === 'number') {
      const page = await resolvePage(pageId);
      if (page) {
        pageName = page.name;
        originalName = page.originalName || page.name;
        isJournal = Boolean(page['journal?']);
        journalDay = page.journalDay;
      }
    }

    if (!pageName) continue;

    results.push({
      uuid: block.uuid,
      content: block.content,
      pageName,
      originalName,
      isJournal,
      journalDay,
    });

    if (results.length >= limit * 2) break;
  }

  results.sort((a, b) => {
    if (a.journalDay && b.journalDay) return b.journalDay - a.journalDay;
    if (a.journalDay) return -1;
    if (b.journalDay) return 1;
    return a.originalName.localeCompare(b.originalName);
  });

  return results.slice(0, limit);
}

/**
 * Search within a single page's block tree (instant even on 1,000+ block pages).
 */
export async function searchInSinglePage(
  pageName: string,
  terms: string[],
  limit = 80
): Promise<SearchResult[]> {
  const page = await logseq.Editor.getPage(pageName);
  const tree = await logseq.Editor.getPageBlocksTree(pageName);
  if (!tree || tree.length === 0) return [];

  const lowerTerms = terms.map((t) =>
    (t.startsWith('#') && t.length > 1 ? t.slice(1) : t).toLowerCase()
  );

  const results: SearchResult[] = [];
  const walk = (nodes: BlockEntity[]) => {
    for (const node of nodes) {
      if (results.length >= limit) return;
      if (node.uuid && node.content) {
        const lower = node.content.toLowerCase();
        if (lowerTerms.every((t) => lower.includes(t))) {
          results.push({
            uuid: node.uuid,
            content: node.content,
            pageName: page?.name ?? pageName,
            originalName: page?.originalName ?? page?.name ?? pageName,
            isJournal: Boolean(page?.['journal?']),
            journalDay: page?.journalDay,
          });
        }
      }
      if (node.children && node.children.length > 0) {
        walk(node.children as BlockEntity[]);
      }
    }
  };

  walk(tree);
  return results;
}

function normalizeForMatch(text: string): string {
  return text
    .replace(/\[\[|\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Find the exact block UUID on a page by matching a text snippet
 * (used when taking over from Logseq's native Ctrl+K search results).
 */
export async function findBlockUuidBySnippet(
  pageName: string,
  snippet: string
): Promise<string | null> {
  const cleanSnippet = normalizeForMatch(snippet);
  if (!cleanSnippet) return null;

  const tree = await logseq.Editor.getPageBlocksTree(pageName);
  if (!tree || tree.length === 0) return null;

  let bestUuid: string | null = null;
  let bestScore = 0;

  const walk = (nodes: BlockEntity[]) => {
    for (const node of nodes) {
      if (node.uuid && node.content) {
        const normalized = normalizeForMatch(node.content);
        if (normalized === cleanSnippet) {
          bestUuid = node.uuid;
          bestScore = 10000;
          return;
        }
        if (normalized.includes(cleanSnippet) || cleanSnippet.includes(normalized)) {
          const score = Math.min(normalized.length, cleanSnippet.length);
          if (score > bestScore) {
            bestScore = score;
            bestUuid = node.uuid;
          }
        }
      }
      if (node.children && node.children.length > 0) {
        walk(node.children as BlockEntity[]);
      }
    }
  };

  walk(tree);
  return bestUuid;
}

/**
 * Walk up the block's parent chain and expand any collapsed ancestors
 * so the target block can actually be rendered into the DOM.
 */
export async function expandBlockAncestors(blockUuid: string): Promise<void> {
  const ancestorUuids: string[] = [];
  let currentId: string | number | undefined = blockUuid;
  const visited = new Set<string>();

  for (let depth = 0; depth < 30 && currentId !== undefined; depth++) {
    const block = await logseq.Editor.getBlock(currentId);
    if (!block || !block.parent || !block.parent.id) break;

    if (block.page && block.parent.id === block.page.id) break;

    const parentBlock = await logseq.Editor.getBlock(block.parent.id);
    if (!parentBlock || !parentBlock.uuid || visited.has(parentBlock.uuid)) break;

    visited.add(parentBlock.uuid);
    ancestorUuids.push(parentBlock.uuid);
    currentId = parentBlock.uuid;
  }

  for (let i = ancestorUuids.length - 1; i >= 0; i--) {
    try {
      await logseq.Editor.setBlockCollapsed(ancestorUuids[i], false);
    } catch {
      // Ignore if already expanded or non-collapsible
    }
  }
}

function escapeQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
