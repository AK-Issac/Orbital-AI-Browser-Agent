import { useState, useRef, useEffect } from 'react';
import './Popup.css';

interface LogEntry {
  message: string;
  type: 'system' | 'thought' | 'success' | 'error' | 'step' | 'warn';
}

interface PendingPlan {
  thought: string;
  actions: { actionType: string; targetId: string; value: string | null }[];
}

type AutonomyMode = 'auto' | 'semi';
type Tab = 'main' | 'settings';

function Popup() {
  const [activeTab, setActiveTab]     = useState<Tab>('main');
  const [prompt, setPrompt]           = useState("");
  const [logs, setLogs]               = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning]     = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [mode, setMode]               = useState<AutonomyMode>('semi');
  
  // Settings State
  const [persona, setPersona]         = useState("");
  const [cvName, setCvName]           = useState<string | null>(null);

  const scrollRef         = useRef<HTMLDivElement>(null);
  const shouldStopRef     = useRef(false);
  const confirmResolveRef = useRef<((approved: boolean) => void) | null>(null);

  // Load settings on mount
  useEffect(() => {
    chrome.storage.local.get(['userPersona', 'cvName'], (result) => {
      if (result.userPersona) setPersona(result.userPersona);
      if (result.cvName) setCvName(result.cvName);
    });
  }, []);

  const handlePersonaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPersona(val);
    chrome.storage.local.set({ userPersona: val });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert("File is too large. Please upload a file smaller than 10MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result;
      chrome.storage.local.set({ cvName: file.name, cvBase64: base64 }, () => {
        setCvName(file.name);
      });
    };
    reader.readAsDataURL(file);
  };

  const handleClearFile = () => {
    chrome.storage.local.remove(['cvName', 'cvBase64'], () => {
      setCvName(null);
    });
  };

  const addLog = (msg: string, type: LogEntry['type'] = 'system') => {
    setLogs(prev => {
      const next = [...prev, { message: msg, type }];
      requestAnimationFrame(() => {
        if (scrollRef.current)
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
      return next;
    });
  };

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const handleStop = () => {
    shouldStopRef.current = true;
    confirmResolveRef.current?.(false);
    confirmResolveRef.current = null;
    setPendingPlan(null);
  };

  const awaitConfirmation = (plan: PendingPlan): Promise<boolean> =>
    new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setPendingPlan(plan);
    });

  const handleConfirm = (approved: boolean) => {
    setPendingPlan(null);
    confirmResolveRef.current?.(approved);
    confirmResolveRef.current = null;
  };

  const executeAction = (
    tabId: number,
    action: { actionType: string; targetId: string; value: string | null }
  ): Promise<{ success: boolean; message: string; mutationDetected?: boolean; urlChanged?: boolean }> =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: "EXECUTE_ACTION", payload: action }, (res) => {
        if (chrome.runtime.lastError || !res)
          resolve({ success: false, message: chrome.runtime.lastError?.message ?? "No response" });
        else
          resolve(res);
      });
    });

  const waitForStable = (tabId: number, timeoutMs = 5000): Promise<void> =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: "WAIT_FOR_STABLE", payload: { timeout: timeoutMs } }, () => {
        if (chrome.runtime.lastError) {
          // Content script might be dead due to page navigation, fallback to a brief sleep
          setTimeout(resolve, 1000);
        } else {
          resolve();
        }
      });
    });

  const runAgent = async () => {
    if (!prompt.trim() || isRunning) return;

    setIsRunning(true);
    setLogs([]);
    shouldStopRef.current = false;
    setActiveTab('main'); // Switch to main tab when running

    const localHistory: string[] = [];
    const isAuto = mode === 'auto';

    addLog(`Mode: ${isAuto ? 'FULLY AUTONOMOUS' : 'SEMI-AUTONOMOUS'}`, isAuto ? 'warn' : 'system');
    await sleep(300);
    addLog("Connection established. Starting agent loop...", 'system');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) {
      addLog("CRITICAL ERROR: No active tab found.", 'error');
      setIsRunning(false);
      return;
    }

    let isCompleted = false;
    let stepCount   = 0;
    const MAX_STEPS = 15;

    while (!isCompleted && stepCount < MAX_STEPS) {

      if (shouldStopRef.current) { addLog("STOPPED by user.", 'warn'); break; }

      stepCount++;
      addLog(`──── STEP ${stepCount} ────`, 'step');
      addLog("Scanning DOM...", 'system');
      
      const scanRes = await new Promise<any>((resolve) => {
        chrome.tabs.sendMessage(tab.id!, { action: "SCAN_PAGE" }, (res) => {
          if (chrome.runtime.lastError) resolve({ status: "error", message: chrome.runtime.lastError.message });
          else resolve(res);
        });
      });

      if (!scanRes || scanRes.status !== "success") {
        addLog(`SCAN_FAILED: ${scanRes?.message || 'Unknown'}`, 'error');
        break;
      }

      const { data: domHtml, pageContext } = scanRes;
      addLog(`Extracted HTML (${domHtml.length} chars) — ${pageContext?.title || 'unknown page'}`, 'system');

      if (shouldStopRef.current) { addLog("STOPPED.", 'warn'); break; }
      addLog("Consulting AI...", 'system');

      const aiRes = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage(
          { action: "PLAN_ACTIONS", payload: { prompt, domHtml, history: localHistory, pageContext, persona, vaultFile: cvName } },
          (res) => resolve(res)
        );
      });

      if (!aiRes || aiRes.status !== "success") {
        addLog(`AI_PLAN_FAILED: ${aiRes?.message}`, 'error');
        break;
      }

      const { thought, actions, taskCompleted } = aiRes.plan;
      addLog(`AI: ${thought}`, 'thought');

      if (taskCompleted && actions.length === 0) {
        addLog("Goal detected — no further actions needed.", 'success');
        isCompleted = true;
        break;
      }

      if (!isAuto && actions.length > 0) {
        if (shouldStopRef.current) { addLog("STOPPED.", 'warn'); break; }
        addLog(`Awaiting confirmation for ${actions.length} action(s)...`, 'system');

        const approved = await awaitConfirmation({ thought, actions });
        if (!approved || shouldStopRef.current) {
          addLog("Plan rejected — halting.", 'warn');
          break;
        }
        addLog("Plan approved.", 'success');
      } else if (isAuto && actions.length > 0) {
        addLog(`Executing ${actions.length} action(s) autonomously...`, 'system');
      }

      // Record the thought in history
      localHistory.push(`[STEP ${stepCount} THOUGHT]: ${thought}`);
      let stepHadFailure = false;

      for (const action of actions) {
        if (shouldStopRef.current) break;

        addLog(`> ${action.actionType.toUpperCase()} → ${action.targetId}`, 'system');
        const result = await executeAction(tab.id!, action);

        if (result.success) {
          if (action.actionType === "click") {
            if (result.urlChanged) {
              addLog(`✓ CLICK — URL changed`, 'success');
              // FIX FOR BUG 1: Explicitly tell the AI it arrived on a new page!
              localHistory.push(`[STEP ${stepCount}] CLICKED "${action.targetId}". SUCCESS: The page URL changed. Assess the new page to see if goal is met.`);
              await waitForStable(tab.id!, 5000); 
            } else if (result.mutationDetected) {
              addLog(`✓ CLICK — DOM mutated`, 'success');
              localHistory.push(`[STEP ${stepCount}] CLICKED "${action.targetId}". SUCCESS: The page updated visually.`);
              await waitForStable(tab.id!, 3000);
            } else {
              addLog(`⚠ CLICK dead — no reaction on ${action.targetId}`, 'warn');
              localHistory.push(`[STEP ${stepCount}] CLICKED "${action.targetId}". WARNING: No reaction from page. Action may have failed.`);
              stepHadFailure = true;
              break;
            }
          } else { // It's a type or upload action
            addLog(`✓ ${action.actionType.toUpperCase()} → ${action.targetId}`, 'success');
            // Explicitly tell the AI it succeeded
            localHistory.push(`[STEP ${stepCount}] ${action.actionType.toUpperCase()} "${action.value}" into "${action.targetId}". SUCCESS.`);
            await sleep(150); // Small sleep for typing is fine
          }
        } else {
          // Option A: Fast Re-plan if element is missing due to React re-render
          if (result.message.includes("not found")) {
            addLog(`⚠ Element missing, triggering fast re-plan...`, 'warn');
            localHistory.push(`[STEP ${stepCount}] Element "${action.targetId}" missing. Page may have re-rendered. Evaluate new DOM.`);
            stepHadFailure = true;
            break;
          } else {
            addLog(`✗ FAILED: ${result.message}`, 'error');
            localHistory.push(`[STEP ${stepCount}] FAILED to ${action.actionType} on "${action.targetId}" — ${result.message}. Try another approach.`);
            stepHadFailure = true;
            break;
          }
        }
      }

      if (taskCompleted && !stepHadFailure) {
        isCompleted = true;
      } else if (!stepHadFailure && !shouldStopRef.current) {
        await waitForStable(tab.id!, 2000);
      } else if (stepHadFailure) {
        addLog("Failure logged. AI will re-evaluate.", 'warn');
        await waitForStable(tab.id!, 1000);
      }

      // Cap history to prevent context window overflow
      while (localHistory.length > 10) {
        localHistory.shift();
      }
    }

    if (isCompleted)
      addLog("━━ MISSION ACCOMPLISHED ━━", 'success');
    else if (!shouldStopRef.current && stepCount >= MAX_STEPS)
      addLog(`ABORTED: ${MAX_STEPS}-step limit reached.`, 'error');

    setIsRunning(false);
  };

  return (
    <div className="terminal-container">

      <div className="terminal-header">
        <div className="window-controls">
          <div className="control red"></div>
          <div className="control yellow"></div>
          <div className="control green"></div>
        </div>
        <div className="terminal-title">AI_AGENT_SHELL_V1.0</div>
        {isRunning && (
          <button className="stop-button" onClick={handleStop}>■ STOP</button>
        )}
      </div>

      <div className="tab-buttons">
        <button className={`tab-btn ${activeTab === 'main' ? 'active' : ''}`} onClick={() => setActiveTab('main')}>MAIN</button>
        <button className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>SETTINGS</button>
      </div>

      <div className="terminal-body">

        {activeTab === 'main' ? (
          <>
            {/* Prompt */}
            <div className="input-section">
              <label className="terminal-label">SYSTEM_INPUT::PROMPT</label>
              <textarea
                className="terminal-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter mission parameters..."
                disabled={isRunning}
              />

              <div className="mode-toggle">
                <button
                  className={`mode-btn ${mode === 'semi' ? 'mode-active' : ''}`}
                  onClick={() => !isRunning && setMode('semi')}
                  disabled={isRunning}
                  title="Pauses before each action — you approve or abort"
                >
                  ⚡ SEMI-AUTO
                </button>
                <button
                  className={`mode-btn mode-btn-danger ${mode === 'auto' ? 'mode-active-danger' : ''}`}
                  onClick={() => !isRunning && setMode('auto')}
                  disabled={isRunning}
                  title="Executes all actions without confirmation — use with caution"
                >
                  ⚠ FULL AUTO
                </button>
              </div>

              <button
                className="terminal-button"
                onClick={runAgent}
                disabled={isRunning || !prompt.trim()}
              >
                {isRunning ? 'EXECUTING...' : 'RUN_MISSION'}
              </button>
            </div>

            {pendingPlan && (
              <div className="confirmation-panel">
                <div className="confirmation-header">⚡ CONFIRM_EXECUTION::PLAN</div>
                <div className="confirmation-thought">{pendingPlan.thought}</div>
                <div className="confirmation-actions">
                  {pendingPlan.actions.map((a, i) => (
                    <div key={i} className="confirmation-action-row">
                      <span className="action-index">[{i + 1}]</span>
                      <span className="action-type">{a.actionType.toUpperCase()}</span>
                      <span className="action-target">→ {a.targetId}</span>
                      {a.value && <span className="action-value">"{a.value}"</span>}
                    </div>
                  ))}
                </div>
                <div className="confirmation-buttons">
                  <button className="btn-approve" onClick={() => handleConfirm(true)}>✓ APPROVE</button>
                  <button className="btn-abort"   onClick={() => handleConfirm(false)}>✗ ABORT</button>
                </div>
              </div>
            )}

            <label className="terminal-label">SYSTEM_LOGS::OUTPUT</label>
            <div className="console-output" ref={scrollRef}>
              {logs.length === 0 ? (
                <div className="log-entry system">
                  Awaiting mission parameters<span className="cursor"></span>
                </div>
              ) : (
                <>
                  {logs.map((log, i) => (
                    <div key={i} className={`log-entry ${log.type}`}>
                      {log.message}
                    </div>
                  ))}
                  {isRunning && !pendingPlan && <div className="cursor"></div>}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="settings-section">
            <label className="terminal-label">PERSONA_ENGINE::DATA</label>
            <textarea
              className="terminal-textarea persona-textarea"
              value={persona}
              onChange={handlePersonaChange}
              placeholder="Name: John Doe&#10;Email: john@example.com&#10;LinkedIn: linkedin.com/in/johndoe"
            />
            
            <label className="terminal-label">FILE_VAULT::STORAGE</label>
            <div className="file-vault-container">
              {cvName ? (
                <div className="vault-file-info">
                  <span className="vault-filename">{cvName}</span>
                  <button className="vault-clear-btn" onClick={handleClearFile}>CLEAR</button>
                </div>
              ) : (
                <input 
                  type="file" 
                  accept=".pdf,.doc,.docx" 
                  onChange={handleFileUpload} 
                  className="vault-file-input"
                />
              )}
            </div>
            <div className="settings-hint">
              * Persona data and files are stored locally in your browser.
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export default Popup;