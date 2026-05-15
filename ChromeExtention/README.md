# Orbital — Chrome Extension

This is the frontend component of the Orbital AI Browser Agent, built with React, TypeScript, and Vite.

## Architecture

The extension uses a persistent **Side Panel** architecture to ensure the agent loop continues even as the user navigates between tabs.

- **Side Panel (`src/sidepanel/`)**: The main user interface. It connects to the background service worker via a persistent `chrome.runtime.Port`.
- **Background Service Worker (`src/background/index.ts`)**: Manages the agent loop, session state, and streaming communication with the backend.
- **Content Script (`src/content/index.ts`)**: Injected into every page to scan the DOM and execute actions (click, type, upload).

## Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the extension:
   ```bash
   npm run build
   ```

3. Load the `dist` folder as an unpacked extension in Chrome.

For full system details and setup instructions, see the [root README](../README.md).
