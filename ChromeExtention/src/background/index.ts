console.log("Background service worker is running!");

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "plan-stream") {
    let abortController: AbortController | null = null;

    port.onMessage.addListener(async (msg) => {
      // Heartbeat ping from popup to keep service worker alive
      if (msg.action === "PING") {
        return; 
      }

      if (msg.action === "STOP") {
        if (abortController) abortController.abort();
        return;
      }

      if (msg.action === "START_PLAN") {
        abortController = new AbortController();
        try {
          const response = await fetch("http://localhost:3000/api/plan/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg.payload),
            signal: abortController.signal
          });

          if (!response.body) throw new Error("No response body");

          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIdx);
              buffer = buffer.slice(newlineIdx + 1);
              if (line.trim()) {
                port.postMessage(JSON.parse(line));
              }
            }
          }
          // Signal stream complete
          port.postMessage({ type: "done" });
        } catch (error: any) {
          if (error.name === 'AbortError') {
            port.postMessage({ type: "error", data: "Stream aborted by user." });
          } else {
            console.error("Stream error:", error);
            port.postMessage({ type: "error", data: error.message });
          }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (abortController) abortController.abort();
    });
  }
});