import '@logseq/libs';
import { openSearchModal } from './ui';
import {
  findBlockElement,
  forceLoadEntirePage,
  jumpToBlock,
} from './scroller';
import { installNativeSearchTakeover } from './nativeTakeover';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractTargetBlockUuid(routeEvent: unknown): {
  pageName?: string;
  blockUuid?: string;
} {
  if (!routeEvent || typeof routeEvent !== 'object') return {};
  const ev = routeEvent as Record<string, unknown>;
  const path = typeof ev.path === 'string' ? ev.path : '';
  const query = (ev.query ?? {}) as Record<string, unknown>;
  const anchor = typeof query.anchor === 'string' ? query.anchor : '';

  // Logseq sometimes puts block UUID in query.anchor or in /page/<uuid>
  let blockUuid: string | undefined;
  if (UUID_REGEX.test(anchor)) {
    blockUuid = anchor;
  }

  let pageName: string | undefined;
  const pageMatch = path.match(/^\/page\/(.+)$/);
  if (pageMatch) {
    const decoded = decodeURIComponent(pageMatch[1]);
    if (!UUID_REGEX.test(decoded)) {
      pageName = decoded;
    }
  }

  return { pageName, blockUuid };
}

async function main(): Promise<void> {
  logseq.useSettingsSchema([
    {
      key: 'autoRescueNavigation',
      type: 'boolean',
      default: true,
      title: 'Auto-rescue native search jumps',
      description:
        'When Logseq navigates to a page with a block anchor and fails to scroll to it, automatically force-load and scroll to that block.',
    },
  ]);

  logseq.provideModel({
    openDeepJump() {
      void openSearchModal(false);
    },
  });

  logseq.App.registerUIItem('toolbar', {
    key: 'deep-jump-toolbar',
    template: `
      <a class="button" data-on-click="openDeepJump" title="Deep Jump: Search &amp; Force-Scroll">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3.5" width="18" height="2.5" rx="1.25" fill="currentColor" />
          <path d="M12 8.5 V15.5 M8.5 12.5 L12 16 L15.5 12.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="4.8" cy="19.5" r="1.8" fill="currentColor" />
          <rect x="8.5" y="18.25" width="12.5" height="2.5" rx="1.25" fill="currentColor" />
        </svg>
      </a>
    `,
  });

  logseq.App.registerCommandPalette(
    {
      key: 'deep-jump-search-all',
      label: 'Deep Jump: Search & Force-Scroll (All Pages)',
      keybinding: {
        binding: 'mod+alt+f',
      },
    },
    () => {
      void openSearchModal(false);
    }
  );

  logseq.App.registerCommandPalette(
    {
      key: 'deep-jump-search-page',
      label: 'Deep Jump: Search & Force-Scroll (Current Page)',
    },
    () => {
      void openSearchModal(true);
    }
  );

  logseq.App.registerCommandPalette(
    {
      key: 'deep-jump-force-load-page',
      label: 'Deep Jump: Force-Load Whole Current Page',
    },
    () => {
      void forceLoadEntirePage();
    }
  );

  let rescuing = false;
  logseq.App.onRouteChanged((ev) => {
    if (rescuing) return;
    const autoRescue = logseq.settings?.autoRescueNavigation !== false;
    if (!autoRescue) return;

    const { pageName, blockUuid } = extractTargetBlockUuid(ev);
    if (!pageName || !blockUuid) return;

    window.setTimeout(async () => {
      try {
        const doc = window.parent?.document;
        if (doc && findBlockElement(doc, blockUuid)) {
          return; // Native Logseq scroll already rendered & found it
        }
        rescuing = true;
        await jumpToBlock(pageName, blockUuid);
      } finally {
        rescuing = false;
      }
    }, 380);
  });

  installNativeSearchTakeover();

  console.log('[Deep Jump] Plugin initialized');
}

logseq.ready(main).catch(console.error);
