console.log("Background service worker is running!");

chrome.runtime.onMessage.addListener((
  request: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => {
  if (request.action === "PLAN_ACTIONS") {
    // ── FIX: history and pageContext were silently dropped before ──
    const { prompt, domHtml, history, pageContext, persona, vaultFile } = request.payload;

    (async () => {
      try {
        const plan = await getAiPlan(prompt, domHtml, history ?? [], pageContext, persona, vaultFile);
        sendResponse({ status: "success", plan });
      } catch (error: any) {
        console.error("Error in getAiPlan:", error);
        sendResponse({ status: "error", message: error.message });
      }
    })();

    return true;
  }
});

async function getAiPlan(
  userPrompt: string,
  domHtml: string,
  history: string[],
  pageContext?: { url: string; title: string },
  persona?: string,
  vaultFile?: string
) {
  const response = await fetch("http://localhost:3000/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: userPrompt, domHtml, history, pageContext, persona, vaultFile })
  });

  const data = await response.json();
  if (data.status === "error") throw new Error(data.message);
  return data.plan;
}