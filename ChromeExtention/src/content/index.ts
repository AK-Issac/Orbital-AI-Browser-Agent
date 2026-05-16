console.log("Content script loaded and running!");

// ─────────────────────────────────────────────
// Page Stability & Mutation Observer
// ─────────────────────────────────────────────
function waitForDomMutation(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; observer.disconnect(); resolve(false); }
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      if (!resolved) { resolved = true; clearTimeout(timer); observer.disconnect(); resolve(true); }
    });

    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
  });
}

function waitForPageStable(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const checkReadyState = () => {
      if (document.readyState === 'complete') {
        startMutationIdleCheck();
      } else {
        window.addEventListener('load', startMutationIdleCheck, { once: true });
      }
    };

    let mutationTimer: ReturnType<typeof setTimeout>;
    let observer: MutationObserver;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (observer) observer.disconnect();
      if (mutationTimer) clearTimeout(mutationTimer);
      resolve();
    };

    const startMutationIdleCheck = () => {
      // Hard timeout for the whole stability check
      setTimeout(finish, timeoutMs);

      observer = new MutationObserver(() => {
        // Reset idle timer on mutation
        clearTimeout(mutationTimer);
        mutationTimer = setTimeout(finish, 500); // 500ms of silence
      });

      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, characterData: true
      });

      // Start the first idle timer
      mutationTimer = setTimeout(finish, 500);
    };

    checkReadyState();
  });
}

// ─────────────────────────────────────────────
// Message listener
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((
  request: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => {

  if (request.action === "SCAN_PAGE") {
    const elements = scanPage();
    sendResponse({
      status: "success",
      data: elements,
      pageContext: {
        url:   window.location.href,
        title: document.title,
      }
    });
    return false; // Synchronous
  }

  else if (request.action === "GET_PAGE_CONTEXT") {
    sendResponse({
      status: "success",
      pageContext: {
        url:   window.location.href,
        title: document.title,
      }
    });
    return false; // Synchronous
  }

  else if (request.action === "WAIT_FOR_STABLE") {
    waitForPageStable(request.payload?.timeout || 5000).then(() => {
      sendResponse({ status: "success" });
    });
    return true; // Asynchronous
  }

  else if (request.action === "NAVIGATE") {
    const { url } = request.payload;
    if (url && url.startsWith('http')) {
      window.location.href = url;
      sendResponse({ status: "success" });
    } else {
      sendResponse({ status: "error", message: `Invalid navigation URL: ${url}` });
    }
    return false; // Synchronous
  }

  else if (request.action === "EXECUTE_ACTION") {
    const { actionType, targetId, value } = request.payload;
    const element = document.querySelector(`[data-agent-id="${targetId}"]`) as HTMLElement;

    if (!element) {
      sendResponse({ status: "error", success: false, message: `Element "${targetId}" not found in DOM` });
      return false; // Synchronous
    }

    if (actionType === "click") {
      const mutationPromise = waitForDomMutation(3000);
      const urlBefore = window.location.href;
      element.click();

      mutationPromise.then((mutationDetected) => {
        const urlChanged = window.location.href !== urlBefore;
        const success    = mutationDetected || urlChanged;
        sendResponse({
          status: "success", success, mutationDetected, urlChanged,
          message: success
            ? `Clicked "${targetId}" — DOM responded`
            : `Clicked "${targetId}" — no DOM change detected`
        });
      });
      return true; // Asynchronous click waiting
    }

    else if (actionType === "type") {
      const inputEl = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      
      // FIX FOR BUG 2: Handle <select> dropdowns properly
      if (inputEl.tagName === 'SELECT') {
        const selectEl = inputEl as HTMLSelectElement;
        let found = false;
        for (let i = 0; i < selectEl.options.length; i++) {
          // Check if AI value matches the option's value OR its visible text
          if (selectEl.options[i].value === value || selectEl.options[i].text.trim() === value) {
            selectEl.selectedIndex = i;
            found = true;
            break;
          }
        }
        if (found) {
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          sendResponse({ status: "success", success: true, message: `Selected option in "${targetId}"` });
        } else {
          sendResponse({ status: "success", success: false, message: `Option "${value}" not found in dropdown "${targetId}"` });
        }
      } 
      // Standard inputs and textareas
      else {
        inputEl.focus();
        inputEl.value = value;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        const success = inputEl.value === value;
        sendResponse({
          status: "success", success,
          message: success ? `Typed into "${targetId}"` : `Type into "${targetId}" failed`
        });
      }
      return false; // Synchronous
    }

    else if (actionType === "upload") {
      const inputEl = element as HTMLInputElement;
      if (inputEl.type !== 'file') {
        sendResponse({ status: "error", success: false, message: `Element "${targetId}" is not a file input` });
        return false; // Synchronous
      }

      chrome.storage.local.get(['cvBase64', 'cvName'], (result) => {
        if (!result.cvBase64 || !result.cvName || result.cvName !== value) {
          sendResponse({ status: "error", success: false, message: `File "${value}" not found in vault.` });
          return;
        }

        try {
          const base64Data = result.cvBase64 as string;
          const filename = result.cvName as string;

          // Convert Base64 to File object
          const arr = base64Data.split(',');
          const mimeMatch = arr[0].match(/:(.*?);/);
          const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while(n--){
              u8arr[n] = bstr.charCodeAt(n);
          }
          const file = new File([u8arr], filename, { type: mime });

          // The DataTransfer Hack
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          inputEl.files = dataTransfer.files;

          // Dispatch events to notify the page
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));

          sendResponse({ status: "success", success: true, message: `Uploaded "${filename}" into "${targetId}"` });
        } catch (err: any) {
          sendResponse({ status: "error", success: false, message: `Upload failed: ${err.message}` });
        }
      });
      return true; // Keep message channel open for async chrome.storage response
    }

    else if (actionType === "navigate") {
      const url = value;
      if (url && url.startsWith('http')) {
        window.location.href = url;
        sendResponse({ status: "success", success: true, message: `Navigating to ${url}` });
      } else {
        sendResponse({ status: "error", success: false, message: `Invalid URL for navigate action: ${url}` });
      }
      return false; // Synchronous
    }

    else {
      sendResponse({ status: "error", success: false, message: `Unknown actionType: "${actionType}"` });
      return false; // Synchronous
    }
  }

  return false; // Default fallback
});

// ─────────────────────────────────────────────
// Visibility check
// ─────────────────────────────────────────────
function isElementVisible(el: HTMLElement): boolean {
  const rect  = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display    !== 'none'   &&
    style.opacity    !== '0'
  );
}

let agentCounter = 0;

function buildSimplifiedHtml(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    let text = node.nodeValue?.trim();
    if (!text) return "";

    const parent = node.parentElement;
    const parentTag = parent?.tagName.toLowerCase() || "";
    const isSafeTag = ["button", "a", "label", "option", "h1", "h2", "h3"].includes(parentTag);

    if (text.length > 100 && !isSafeTag) {
      text = text.substring(0, 100) + "... [TRUNCATED]";
    }
    return text + " ";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // Skip noise
  if (['script', 'style', 'noscript', 'svg', 'iframe', 'img', 'video', 'audio', 'link', 'meta'].includes(tag)) return "";
  
  // FIX: Pre-scan cleanup of hidden elements
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return "";
  }

  const isInteractive = ['button', 'input', 'a', 'select', 'textarea'].includes(tag) || 
                        el.getAttribute('role') === 'button' || 
                        el.getAttribute('role') === 'link';
  
  if (!isInteractive && !isElementVisible(el) && el.children.length === 0) return "";

  let html = `<${tag}`;

  if (isInteractive) {
    const agentId = `agent-${agentCounter++}`;
    el.setAttribute('data-agent-id', agentId);
    el.style.outline = "2px solid #ff00ff80";
    html += ` data-agent-id="${agentId}"`;

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const val = (el as HTMLInputElement).value;
      if (val) html += ` value="${val}"`;
      if ((el as HTMLInputElement).type) html += ` type="${(el as HTMLInputElement).type}"`;
      if ((el as HTMLInputElement).placeholder) html += ` placeholder="${(el as HTMLInputElement).placeholder}"`;
      
      if (tag === 'select') {
         const options = Array.from((el as HTMLSelectElement).options).map(o => o.text.trim()).join('|');
         if (options) html += ` options="${options}"`;
      }
    }
    
    if (tag === 'a' && (el as HTMLAnchorElement).href) {
      const href = (el as HTMLAnchorElement).href;
      if (!href.startsWith('javascript:')) html += ` href="${href.substring(0, 100)}"`;
    }
    if (el.getAttribute('aria-label')) html += ` aria-label="${el.getAttribute('aria-label')}"`;
  }

  html += ">";

  let childrenHtml = "";
  
  // 1. Walk Light DOM
  for (let i = 0; i < el.childNodes.length; i++) {
    childrenHtml += buildSimplifiedHtml(el.childNodes[i]);
  }

  // 2. Walk Shadow DOM (Critical for YouTube/Modern Web)
  if (el.shadowRoot) {
    for (let i = 0; i < el.shadowRoot.childNodes.length; i++) {
      childrenHtml += buildSimplifiedHtml(el.shadowRoot.childNodes[i]);
    }
  }

  // Optimization: If it's not interactive and has no text/interactive children, just strip it.
  if (!isInteractive && !childrenHtml.trim()) {
    return "";
  }

  html += childrenHtml;
  html += `</${tag}>`;
  return html;
}

// ─────────────────────────────────────────────
// DOM scanner
// ─────────────────────────────────────────────
function scanPage() {
  // Clear old agent-ids to prevent collisions on subsequent scans
  document.querySelectorAll('[data-agent-id]').forEach(el => {
    el.removeAttribute('data-agent-id');
    (el as HTMLElement).style.outline = '';
  });

  agentCounter = 0;
  // Build a clean HTML representation starting from body
  let htmlString = buildSimplifiedHtml(document.body);
  
  // Truncate to avoid exploding context windows (gpt-4o can handle a lot, but safety first)
  if (htmlString.length > 80000) {
    htmlString = htmlString.substring(0, 80000) + "... [HTML TRUNCATED]";
  }
  return htmlString;
}