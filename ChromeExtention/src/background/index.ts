console.log("Background service worker is running!");

// ─── Types ───
interface LogEntry {
  message: string;
  type: 'system' | 'thought' | 'success' | 'error' | 'step' | 'warn';
}

interface PendingPlan {
  thought: string;
  actions: { actionType: string; targetId: string; value: string | null }[];
}

type AutonomyMode = 'auto' | 'semi';

interface AgentState {
  isRunning: boolean;
  prompt: string;
  logs: LogEntry[];
  mode: AutonomyMode;
  persona: string;
  cvName: string | null;
  pendingPlan: PendingPlan | null;
  totalTokens: number;
  sessionCost: number;
  shouldStop: boolean;
  isCompleted: boolean;
  stepCount: number;
  history: string[];
  currentTabId: number | null;
}

// ─── In-Memory State ───
const state: AgentState = {
  isRunning: false,
  prompt: '',
  logs: [],
  mode: 'semi',
  persona: '',
  cvName: null,
  pendingPlan: null,
  totalTokens: 0,
  sessionCost: 0,
  shouldStop: false,
  isCompleted: false,
  stepCount: 0,
  history: [],
  currentTabId: null,
};

let confirmResolve: ((approved: boolean) => void) | null = null;
let abortController: AbortController | null = null;
const sidePanelPorts: Set<chrome.runtime.Port> = new Set();

// ─── Side Panel Setup ───
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

// ─── Port Management ───
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPorts.add(port);
    port.postMessage({ type: 'STATE_UPDATE', state: getSerializableState() });

    port.onMessage.addListener(async (msg) => {
      switch (msg.type) {
        case 'GET_STATE':
          port.postMessage({ type: 'STATE_UPDATE', state: getSerializableState() });
          break;

        case 'START_AGENT':
          if (state.isRunning) break;
          state.prompt = msg.prompt;
          state.mode = msg.mode ?? state.mode;
          state.persona = msg.persona ?? state.persona;
          state.shouldStop = false;
          state.isCompleted = false;
          state.stepCount = 0;
          state.history = [];
          state.logs = [];
          state.totalTokens = 0;
          state.sessionCost = 0;
          state.pendingPlan = null;
          broadcastState();
          runAgent();
          break;

        case 'STOP_AGENT':
          state.shouldStop = true;
          confirmResolve?.(false);
          confirmResolve = null;
          state.pendingPlan = null;
          abortController?.abort();
          broadcastState();
          break;

        case 'APPROVE_PLAN':
          if (confirmResolve) {
            confirmResolve(true);
            confirmResolve = null;
            state.pendingPlan = null;
            broadcastState();
          }
          break;

        case 'REJECT_PLAN':
          if (confirmResolve) {
            confirmResolve(false);
            confirmResolve = null;
            state.pendingPlan = null;
            broadcastState();
          }
          break;

        case 'SET_MODE':
          state.mode = msg.mode;
          await chrome.storage.local.set({ agentMode: msg.mode });
          broadcastState();
          break;

        case 'SET_PERSONA':
          state.persona = msg.persona;
          await chrome.storage.local.set({ userPersona: msg.persona });
          break;

        case 'UPLOAD_FILE':
          state.cvName = msg.cvName;
          await chrome.storage.local.set({ cvName: msg.cvName, cvBase64: msg.cvBase64 });
          broadcastState();
          break;

        case 'CLEAR_FILE':
          state.cvName = null;
          await chrome.storage.local.remove(['cvName', 'cvBase64']);
          broadcastState();
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      sidePanelPorts.delete(port);
    });
  }
});

function broadcast(message: any) {
  const dead: chrome.runtime.Port[] = [];
  sidePanelPorts.forEach((port) => {
    try {
      port.postMessage(message);
    } catch {
      dead.push(port);
    }
  });
  dead.forEach((p) => sidePanelPorts.delete(p));
}

function getSerializableState(): any {
  return { ...state };
}

function addLog(msg: string, type: LogEntry['type'] = 'system') {
  const log: LogEntry = { message: msg, type };
  state.logs.push(log);
  if (state.logs.length > 500) state.logs.shift();
  broadcast({ type: 'LOG_APPEND', log, logs: state.logs });
}

function broadcastState() {
  broadcast({ type: 'STATE_UPDATE', state: getSerializableState() });
}

function setRunning(running: boolean) {
  state.isRunning = running;
  broadcastState();
}

// ─── Load persisted settings ───
async function loadPersistedState() {
  const res = await chrome.storage.local.get(['userPersona', 'cvName', 'agentMode']);
  if (res.userPersona) state.persona = res.userPersona as string;
  if (res.cvName) state.cvName = res.cvName as string;
  if (res.agentMode) state.mode = res.agentMode as AutonomyMode;
}
loadPersistedState();

// ─── Message Router ───
// All commands now arrive via the persistent port (port.onMessage above).
// chrome.runtime.sendMessage is no longer used by the side panel.

// ─── Agent Loop ───
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAgent() {
  setRunning(true);
  const isAuto = state.mode === 'auto';

  addLog(`Mode: ${isAuto ? 'FULLY AUTONOMOUS' : 'SEMI-AUTONOMOUS'}`, isAuto ? 'warn' : 'system');
  await sleep(300);
  addLog('Connection established. Starting agent loop...', 'system');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    addLog('CRITICAL ERROR: No active tab found.', 'error');
    setRunning(false);
    return;
  }

  state.currentTabId = tab.id;
  let isCompleted = false;
  let stepCount = 0;
  const MAX_STEPS = 15;

  while (!isCompleted && stepCount < MAX_STEPS) {
    if (state.shouldStop) {
      addLog('STOPPED by user.', 'warn');
      break;
    }

    stepCount++;
    state.stepCount = stepCount;
    addLog(`──── STEP ${stepCount} ────`, 'step');

    // 1. Quick Context Check
    addLog('Checking goal status...', 'system');
    const contextRes = await new Promise<any>((resolve) => {
      chrome.tabs.sendMessage(tab.id!, { action: 'GET_PAGE_CONTEXT' }, (res) => {
        if (chrome.runtime.lastError) resolve({ status: 'error', message: chrome.runtime.lastError.message });
        else resolve(res);
      });
    });

    if (contextRes?.status === 'success') {
      const { pageContext } = contextRes;
      try {
        const qcResponse = await fetch('http://localhost:3000/api/quickcheck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: state.prompt, pageContext, history: state.history }),
        });
        const quickCheck = await qcResponse.json();
        if (quickCheck.goalMet) {
          addLog('Goal detected from page context — no scan needed.', 'success');
          isCompleted = true;
          break;
        }
      } catch (e) {
        console.warn('Quick check failed, proceeding to full scan', e);
      }
    }

    if (state.shouldStop) {
      addLog('STOPPED.', 'warn');
      break;
    }

    // 2. Full DOM Scan
    addLog('Scanning DOM...', 'system');
    const scanRes = await new Promise<any>((resolve) => {
      chrome.tabs.sendMessage(tab.id!, { action: 'SCAN_PAGE' }, (res) => {
        if (chrome.runtime.lastError) resolve({ status: 'error', message: chrome.runtime.lastError.message });
        else resolve(res);
      });
    });

    if (!scanRes || scanRes.status !== 'success') {
      addLog(`SCAN_FAILED: ${scanRes?.message || 'Unknown'}`, 'error');
      break;
    }

    const { data: domHtml, pageContext } = scanRes;
    addLog(`Extracted HTML (${domHtml.length} chars) — ${pageContext?.title || 'unknown page'}`, 'system');

    if (state.shouldStop) {
      addLog('STOPPED.', 'warn');
      break;
    }
    addLog('Consulting AI...', 'system');

    let currentThought = '';
    let thoughtLogIndex = state.logs.length;
    addLog('AI is thinking...', 'thought');

    abortController = new AbortController();

    const aiRes = await (async () => {
      try {
        const response = await fetch('http://localhost:3000/api/plan/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: state.prompt,
            domHtml,
            history: state.history,
            pageContext,
            persona: state.persona,
            vaultFile: state.cvName,
          }),
          signal: abortController.signal,
        });

        if (!response.body) throw new Error('No response body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finalPlan: any = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 2);

            if (chunk.startsWith('data: ')) {
              try {
                const msg = JSON.parse(chunk.slice(6));

                if (msg.type === 'thought') {
                  currentThought += msg.data;
                  if (thoughtLogIndex >= 0) {
                    state.logs[thoughtLogIndex] = { message: 'AI: ' + currentThought, type: 'thought' };
                    broadcast({ type: 'THOUGHT_UPDATE', message: 'AI: ' + currentThought });
                  }
                } else if (msg.type === 'usage') {
                  if (msg.data.total_tokens) {
                    state.totalTokens += msg.data.total_tokens;
                    const inputCost = (msg.data.prompt_tokens / 1_000_000) * 5;
                    const outputCost = (msg.data.completion_tokens / 1_000_000) * 15;
                    state.sessionCost += inputCost + outputCost;
                    broadcastState();
                  }
                } else if (msg.type === 'plan') {
                  finalPlan = msg.data;
                } else if (msg.type === 'error') {
                  return { status: 'error', message: msg.data };
                }
              } catch {
                /* malformed chunk, skip */
              }
            }
          }
        }

        return finalPlan
          ? { status: 'success', plan: finalPlan }
          : { status: 'error', message: 'Stream ended without a plan.' };
      } catch (err: any) {
        if (err.name === 'AbortError') return { status: 'error', message: 'Stopped by user.' };
        return { status: 'error', message: err.message };
      }
    })();

    if (!aiRes || aiRes.status !== 'success') {
      addLog(`AI_PLAN_FAILED: ${aiRes?.message}`, 'error');
      break;
    }

    const { thought, actions, taskCompleted } = aiRes.plan;

    if (taskCompleted && actions.length === 0) {
      addLog('Goal detected — no further actions needed.', 'success');
      isCompleted = true;
      break;
    }

    if (!isAuto && actions.length > 0) {
      if (state.shouldStop) {
        addLog('STOPPED.', 'warn');
        break;
      }
      addLog(`Awaiting confirmation for ${actions.length} action(s)...`, 'system');

      const approved = await new Promise<boolean>((resolve) => {
        confirmResolve = resolve;
        state.pendingPlan = { thought, actions };
        broadcastState();
      });

      if (!approved || state.shouldStop) {
        addLog('Plan rejected — halting.', 'warn');
        break;
      }
      addLog('Plan approved.', 'success');
    } else if (isAuto && actions.length > 0) {
      addLog(`Executing ${actions.length} action(s) autonomously...`, 'system');
    }

    state.history.push(`[STEP ${stepCount} THOUGHT]: ${thought}`);
    let stepHadFailure = false;

    for (const action of actions) {
      if (state.shouldStop) break;

      addLog(`> ${action.actionType.toUpperCase()} → ${action.targetId}`, 'system');
      const result = await executeAction(tab.id!, action);

      if (result.success) {
        if (action.actionType === 'click') {
          if (result.urlChanged) {
            addLog(`✓ CLICK — URL changed`, 'success');
            state.history.push(`[STEP ${stepCount}] CLICKED "${action.targetId}". SUCCESS: The page URL changed. Assess the new page to see if goal is met.`);
            await waitForStable(tab.id!, 5000);
          } else if (result.mutationDetected) {
            addLog(`✓ CLICK — DOM mutated`, 'success');
            state.history.push(`[STEP ${stepCount}] CLICKED "${action.targetId}". SUCCESS: The page updated visually.`);
            await waitForStable(tab.id!, 3000);
          } else {
            addLog(`⚠ CLICK dead — no reaction on ${action.targetId}`, 'warn');
            state.history.push(`[STEP ${stepCount}] CLICKED "${action.targetId}". WARNING: No reaction from page. Action may have failed.`);
            stepHadFailure = true;
            break;
          }
        } else {
          addLog(`✓ ${action.actionType.toUpperCase()} → ${action.targetId}`, 'success');
          state.history.push(`[STEP ${stepCount}] ${action.actionType.toUpperCase()} "${action.value}" into "${action.targetId}". SUCCESS.`);
          await sleep(150);
        }
      } else {
        if (result.message?.includes('not found')) {
          addLog(
            `⚠ ACTION FAILED: Attempted to ${action.actionType.toUpperCase()} "${action.targetId}" but the element vanished. The page likely re-rendered. The AI will re-evaluate the new DOM.`,
            'warn'
          );
          state.history.push(`[STEP ${stepCount}] Element "${action.targetId}" missing. Page may have re-rendered. Evaluate new DOM.`);
          stepHadFailure = true;
          break;
        } else {
          addLog(
            `✗ ACTION FAILED: Could not ${action.actionType.toUpperCase()} on "${action.targetId}" (${result.message}). The AI will find another approach.`,
            'error'
          );
          state.history.push(`[STEP ${stepCount}] FAILED to ${action.actionType} on "${action.targetId}" — ${result.message}. Try another approach.`);
          stepHadFailure = true;
          break;
        }
      }
    }

    if (taskCompleted && !stepHadFailure) {
      isCompleted = true;
    } else if (!stepHadFailure && !state.shouldStop) {
      await waitForStable(tab.id!, 2000);
    } else if (stepHadFailure) {
      addLog('Failure logged. AI will re-evaluate.', 'warn');
      await waitForStable(tab.id!, 1000);
    }

    while (state.history.length > 10) {
      state.history.shift();
    }
    broadcastState();
  }

  if (isCompleted) addLog('━━ MISSION ACCOMPLISHED ━━', 'success');
  else if (!state.shouldStop && stepCount >= MAX_STEPS) addLog(`ABORTED: ${MAX_STEPS}-step limit reached.`, 'error');

  setRunning(false);
  state.shouldStop = false;
  state.pendingPlan = null;
  state.currentTabId = null;
  broadcastState();
}

async function executeAction(tabId: number, action: any) {
  return new Promise<any>((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'EXECUTE_ACTION', payload: action }, (res) => {
      if (chrome.runtime.lastError || !res) {
        resolve({ success: false, message: chrome.runtime.lastError?.message ?? 'No response' });
      } else {
        resolve(res);
      }
    });
  });
}

async function waitForStable(tabId: number, timeoutMs = 5000) {
  return new Promise<void>((resolve) => {
    if (state.shouldStop) return resolve();
    chrome.tabs.sendMessage(tabId, { action: 'WAIT_FOR_STABLE', payload: { timeout: timeoutMs } }, () => {
      if (chrome.runtime.lastError) {
        setTimeout(resolve, 1000);
      } else {
        resolve();
      }
    });
  });
}