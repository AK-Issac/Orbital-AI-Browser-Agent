import { useState, useRef, useEffect } from 'react';
import './SidePanel.css';

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

function SidePanel() {
  const [activeTab, setActiveTab]     = useState<Tab>('main');
  const [prompt, setPrompt]           = useState("");
  const [logs, setLogs]               = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning]     = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [mode, setMode]               = useState<AutonomyMode>('semi');
  const [persona, setPersona]         = useState("");
  const [cvName, setCvName]           = useState<string | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [sessionCost, setSessionCost] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const portRef   = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    portRef.current = port;

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'STATE_UPDATE': {
          const s = msg.state;
          setIsRunning(s.isRunning ?? false);
          setPendingPlan(s.pendingPlan ?? null);
          setMode(s.mode ?? 'semi');
          setPersona(s.persona ?? '');
          setCvName(s.cvName ?? null);
          setTotalTokens(s.totalTokens ?? 0);
          setSessionCost(s.sessionCost ?? 0);
          if (Array.isArray(s.logs)) setLogs(s.logs);
          break;
        }
        case 'LOG_APPEND':
          setLogs(prev => [...prev, msg.log]);
          break;
        case 'THOUGHT_UPDATE':
          setLogs(prev => {
            const next = [...prev];
            const lastIdx = next.length - 1;
            if (lastIdx >= 0 && next[lastIdx].type === 'thought') {
              next[lastIdx] = { ...next[lastIdx], message: msg.message };
            } else {
              next.push({ message: msg.message, type: 'thought' });
            }
            return next;
          });
          break;
        case 'REQUEST_CONFIRMATION':
          setPendingPlan(msg.plan);
          break;
      }
    });

    port.postMessage({ type: 'GET_STATE' });

    return () => port.disconnect();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleStart = () => {
    if (!prompt.trim() || isRunning) return;
    setActiveTab('main');
    portRef.current?.postMessage({
      type: 'START_AGENT',
      prompt,
      mode,
      persona
    });
  };

  const handleStop = () => {
    portRef.current?.postMessage({ type: 'STOP_AGENT' });
  };

  const handleConfirm = (approved: boolean) => {
    portRef.current?.postMessage({
      type: approved ? 'APPROVE_PLAN' : 'REJECT_PLAN'
    });
  };

  const handleModeChange = (newMode: AutonomyMode) => {
    if (isRunning) return;
    setMode(newMode);
    portRef.current?.postMessage({ type: 'SET_MODE', mode: newMode });
  };

  const handlePersonaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPersona(val);
    portRef.current?.postMessage({ type: 'SET_PERSONA', persona: val });
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
      const base64 = event.target?.result as string;
      portRef.current?.postMessage({
        type: 'UPLOAD_FILE',
        cvName: file.name,
        cvBase64: base64
      });
    };
    reader.readAsDataURL(file);
  };

  const handleClearFile = () => {
    portRef.current?.postMessage({ type: 'CLEAR_FILE' });
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

        <div className={`token-counter ${totalTokens > 50000 ? 'warning' : ''}`} title="Session Tokens">
          Tokens: {(totalTokens / 1000).toFixed(1)}k | Cost: ${sessionCost.toFixed(3)}
        </div>

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
                  onClick={() => handleModeChange('semi')}
                  disabled={isRunning}
                  title="Pauses before each action — you approve or abort"
                >
                  ⚡ SEMI-AUTO
                </button>
                <button
                  className={`mode-btn mode-btn-danger ${mode === 'auto' ? 'mode-active-danger' : ''}`}
                  onClick={() => handleModeChange('auto')}
                  disabled={isRunning}
                  title="Executes all actions without confirmation — use with caution"
                >
                  ⚠ FULL AUTO
                </button>
              </div>

              <button
                className="terminal-button"
                onClick={handleStart}
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

export default SidePanel;