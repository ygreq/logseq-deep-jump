# Deep Jump (Search & Force-Scroll) for Logseq

A Logseq plugin that solves the issue where jumping to a note on a massive journal or page (1,000+ blocks) drops you at the top because Logseq's lazy loader has not rendered the target block yet.

## Features

- **Deep Jump Search (`Ctrl+Alt+F` / `Cmd+Option+F` or toolbar icon):**
  - Multi-word case-insensitive DataScript search across **All Pages** or **Current Page**.
  - **Enter**: Navigates to the page, expands any collapsed parent blocks, progressively triggers Logseq's lazy loader until the exact block appears in the DOM, centers it, and highlights it.
  - **Shift + Enter**: Opens the block directly in the Right Sidebar.
- **Force-Load Whole Current Page:** Command palette action (`Deep Jump: Force-Load Whole Current Page`) to load every lazy-loaded block on the active page so native `Ctrl+F` works too.
- **Auto-Rescue Native Jumps:** Optional setting (`autoRescueNavigation`, enabled by default) that watches route changes with a block anchor and automatically force-scrolls if Logseq's built-in scroll misses the block.

## Build & Install (Unpacked Plugin)

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
2. In Logseq Desktop:
   - Open **Settings -> Advanced -> Developer mode** (turn it ON).
   - Open **Plugins -> Load unpacked plugin**.
   - Select the cloned plugin folder (`logseq-deep-jump`).
