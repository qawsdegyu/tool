'use client';
import { useState, useRef, useCallback } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────
interface AgentLog { level: string; message: string; ts: number; }
interface AgentResult {
  logs: AgentLog[];
  bigpipeParams: Record<string, string>;
  interceptedRequests: { url: string; method: string; postData?: string; parsedParams?: Record<string, string> }[];
  htmlTokens: Record<string, string>;
  mergedParams: Record<string, string>;
  pageTitle: string;
  captchaDetected: boolean;
  error?: string;
}
interface SubmitResult {
  success: boolean;
  status: number;
  responseText: string;
  submittedUrl: string;
  submittedBody: string;
  captchaRequired: boolean;
  captchaPersistData?: string;
  error?: string;
  ticketId?: string;
}

const BIGPIPE_KEYS = ['fb_dtsg','lsd','jazoest','__dyn','__hs','__hsi','__s','__rev','__req','__spin_r','__spin_b','__spin_t'];
const LOG_COLORS: Record<string, string> = { info:'#4f8aff', success:'#22c55e', warn:'#f59e0b', error:'#ef4444', debug:'#6b7280' };

const COUNTRIES = [
  {"code": "AF", "name": "Afghanistan"},
  {"code": "AL", "name": "Albania"},
  {"code": "DZ", "name": "Algeria"},
  {"code": "AR", "name": "Argentina"},
  {"code": "AU", "name": "Australia"},
  {"code": "AT", "name": "Austria"},
  {"code": "BH", "name": "Bahrain"},
  {"code": "BD", "name": "Bangladesh"},
  {"code": "BR", "name": "Brazil"},
  {"code": "CA", "name": "Canada"},
  {"code": "CN", "name": "China"},
  {"code": "CO", "name": "Colombia"},
  {"code": "EG", "name": "Egypt"},
  {"code": "FR", "name": "France"},
  {"code": "DE", "name": "Germany"},
  {"code": "GR", "name": "Greece"},
  {"code": "IN", "name": "India"},
  {"code": "ID", "name": "Indonesia"},
  {"code": "IQ", "name": "Iraq"},
  {"code": "IE", "name": "Ireland"},
  {"code": "IT", "name": "Italy"},
  {"code": "JP", "name": "Japan"},
  {"code": "JO", "name": "Jordan"},
  {"code": "KW", "name": "Kuwait"},
  {"code": "LB", "name": "Lebanon"},
  {"code": "LY", "name": "Libya"},
  {"code": "MY", "name": "Malaysia"},
  {"code": "MX", "name": "Mexico"},
  {"code": "MA", "name": "Morocco"},
  {"code": "NL", "name": "Netherlands"},
  {"code": "NZ", "name": "New Zealand"},
  {"code": "NG", "name": "Nigeria"},
  {"code": "OM", "name": "Oman"},
  {"code": "PK", "name": "Pakistan"},
  {"code": "PS", "name": "Palestine"},
  {"code": "PH", "name": "Philippines"},
  {"code": "QA", "name": "Qatar"},
  {"code": "RU", "name": "Russia"},
  {"code": "SA", "name": "Saudi Arabia"},
  {"code": "ES", "name": "Spain"},
  {"code": "SD", "name": "Sudan"},
  {"code": "SE", "name": "Sweden"},
  {"code": "SY", "name": "Syria"},
  {"code": "TN", "name": "Tunisia"},
  {"code": "TR", "name": "Turkey"},
  {"code": "AE", "name": "United Arab Emirates"},
  {"code": "GB", "name": "United Kingdom"},
  {"code": "US", "name": "United States"},
  {"code": "YE", "name": "Yemen"}
];

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Component ──────────────────────────────────────────────────────────────
export default function Home() {
  const [activeTab, setActiveTab] = useState<'extract' | 'submit' | 'logs' | 'reqs'>('extract');
  const [cdpPort, setCdpPort] = useState('9222');
  const [targetUrl, setTargetUrl] = useState('https://www.facebook.com/help/contact/649167531904667');
  const [formUrl, setFormUrl] = useState('https://www.facebook.com/help/contact/649167531904667');
  const [accountId, setAccountId] = useState('');
  const [country, setCountry] = useState('');
  const [message, setMessage] = useState('');
  const [manualCookies, setManualCookies] = useState('');
  const [fbDtsg, setFbDtsg] = useState('');
  const [jazoest, setJazoest] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaPersistData, setCaptchaPersistData] = useState('');
  const [reqCounter, setReqCounter] = useState(1);

  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cdpStatus, setCdpStatus] = useState<'unknown' | 'ok' | 'err'>('unknown');

  const terminalRef = useRef<HTMLDivElement>(null);

  // ── Ping CDP ──
  const pingCDP = useCallback(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      setCdpStatus(r.ok ? 'ok' : 'err');
    } catch { setCdpStatus('err'); }
  }, [cdpPort]);

  // ── Run extraction ──
  const runExtraction = useCallback(async () => {
    setRunning(true);
    setAgentResult(null);
    try {
      const res = await fetch('/api/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: Number(cdpPort), url: targetUrl }),
      });
      const data: AgentResult = await res.json();
      setAgentResult(data);
      // Auto-populate captchaPersistData if detected
      if (data.captchaDetected) setCaptchaPersistData('');
      // Scroll terminal
      setTimeout(() => terminalRef.current?.scrollTo({ top: 999999 }), 100);
    } catch (e: unknown) {
      setAgentResult({ logs: [{ level: 'error', message: String(e), ts: Date.now() }], bigpipeParams: {}, interceptedRequests: [], htmlTokens: {}, mergedParams: {}, pageTitle: '', captchaDetected: false });
    } finally { setRunning(false); }
  }, [cdpPort, targetUrl]);

  // ── Submit form ──
  const runSubmit = useCallback(async (isResubmit = false) => {
    setSubmitting(true);
    setSubmitResult(null);
    const counter = isResubmit ? reqCounter + 1 : reqCounter;
    try {
      let fields: Record<string, string> = {};
      if (accountId) fields['account_id'] = accountId;
      if (country) fields['country'] = country;
      if (message) fields['message'] = message;
      
      const payload = {
        accountId: accountId,
        country: country,
        message: message,
        cookies: manualCookies || undefined,
        fbDtsg: fbDtsg || undefined,
        jazoest: jazoest || undefined,
        reqCounter: counter
      };

      const res = await fetch('/api/facebook/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setSubmitResult({
        success: data.success,
        status: data.status || res.status,
        responseText: data.response || data.error || JSON.stringify(data),
        submittedUrl: '/api/facebook/submit (Next.js Edge)',
        submittedBody: JSON.stringify(payload),
        captchaRequired: false,
        ticketId: data.ticketId
      });
    } catch (e: unknown) {
      setSubmitResult({ success: false, status: 0, responseText: String(e), submittedUrl: '', submittedBody: '', captchaRequired: false, error: String(e) });
    } finally { setSubmitting(false); }
  }, [agentResult, cdpPort, formUrl, accountId, country, message, manualCookies, fbDtsg, jazoest, captchaToken, captchaPersistData, reqCounter]);

  const mergedEntries = agentResult ? Object.entries(agentResult.mergedParams) : [];
  const hasParams = mergedEntries.length > 0;
  const canSubmit = hasParams || manualCookies.trim().length > 0;

  return (
    <div className="layout">
      {/* ── Top bar ── */}
      <div className="topbar">
        <span className="topbar-logo">⚡ FB Agent</span>
        <div className="topbar-status">
          <div className={`dot ${cdpStatus === 'ok' ? 'ok' : cdpStatus === 'err' ? 'err' : ''}`} />
          <span>CDP :{cdpPort}</span>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={pingCDP}>Ping</button>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="tabs-row">
        {([['extract','🔍 Extract Params'],['submit','📤 Submit Form'],['logs','📋 Logs'],['reqs','🌐 Network Reqs']] as const).map(([id, label]) => (
          <button key={id} className={`tab-btn${activeTab === id ? ' active' : ''}`} onClick={() => setActiveTab(id)}>
            {label} {id === 'logs' && agentResult?.logs.length ? `(${agentResult.logs.length})` : ''}
            {id === 'reqs' && agentResult?.interceptedRequests.length ? `(${agentResult.interceptedRequests.length})` : ''}
          </button>
        ))}
      </div>

      <div className="content">
        {/* ════════════════ EXTRACT PANEL ════════════════ */}
        <div className={`panel${activeTab === 'extract' ? ' active' : ''}`}>
          <div className="card">
            <div className="card-header">🔍 BigPipe Param Extractor</div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group">
                  <label>CDP Port</label>
                  <input value={cdpPort} onChange={e => setCdpPort(e.target.value)} placeholder="9222" />
                </div>
                <div className="form-group">
                  <label>Target URL (Facebook page)</label>
                  <input value={targetUrl} onChange={e => setTargetUrl(e.target.value)} placeholder="https://www.facebook.com" />
                </div>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" onClick={runExtraction} disabled={running}>
                  {running ? <><span className="spinner" />Extracting…</> : '▶ Run Extraction'}
                </button>
                <button className="btn btn-ghost" onClick={pingCDP}>Ping CDP</button>
              </div>
            </div>
          </div>

          {agentResult && (
            <>
              <div className="status-row">
                <span className={`stat-chip${agentResult.captchaDetected ? ' warn' : ' ok'}`}>
                  {agentResult.captchaDetected ? '⚠️ CAPTCHA Detected' : '✓ No CAPTCHA'}
                </span>
                <span className={`stat-chip${hasParams ? ' ok' : ' err'}`}>
                  {hasParams ? `✓ ${mergedEntries.length} params captured` : '✗ No params'}
                </span>
                <span className="stat-chip">{agentResult.pageTitle || 'Unknown page'}</span>
              </div>

              <div className="card">
                <div className="card-header">🔑 Merged BigPipe Params <small style={{color:'#6b7280',fontWeight:400,marginLeft:8}}>Network &gt; Runtime &gt; HTML</small></div>
                <div className="card-body" style={{ padding: 0 }}>
                  {hasParams ? (
                    <table className="params-table">
                      <thead><tr><th>Key</th><th>Value</th><th>Source</th></tr></thead>
                      <tbody>
                        {mergedEntries.map(([k, v]) => (
                          <tr key={k}>
                            <td style={{ color: '#7c5cfc', fontWeight: 600 }}>{k}</td>
                            <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</td>
                            <td>
                              {agentResult.bigpipeParams[k] ? <span className="badge badge-net">Network</span>
                               : agentResult.htmlTokens[k] ? <span className="badge badge-html">HTML</span>
                               : <span className="badge badge-rt">Runtime</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <div className="empty">No params extracted yet</div>}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ════════════════ SUBMIT PANEL ════════════════ */}
        <div className={`panel${activeTab === 'submit' ? ' active' : ''}`}>
          <div className="card">
            <div className="card-header">📤 Form Submission</div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group">
                  <label>Account ID</label>
                  <input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="e.g. 123456789" />
                </div>
                <div className="form-group">
                  <label>Country</label>
                  <select value={country} onChange={e => setCountry(e.target.value)}>
                    <option value="">Select a country...</option>
                    {COUNTRIES.map(c => (
                      <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Support Request / Message</label>
                <textarea value={message} onChange={e => setMessage(e.target.value)} style={{ minHeight: 60 }} placeholder="Please describe your issue..." />
              </div>
              <div className="form-group">
                <label>Cookies (c_user=...; xs=...)</label>
                <textarea value={manualCookies} onChange={e => setManualCookies(e.target.value)} style={{ minHeight: 60 }} placeholder="Paste cookies here..." />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>fb_dtsg (Optional - overrides auto-scraper)</label>
                  <input value={fbDtsg} onChange={e => setFbDtsg(e.target.value)} placeholder="e.g. NAcO..." />
                </div>
                <div className="form-group">
                  <label>jazoest (Optional)</label>
                  <input value={jazoest} onChange={e => setJazoest(e.target.value)} placeholder="e.g. 22134..." />
                </div>
              </div>
              
              {submitResult?.captchaRequired && (
                <div className="form-group" style={{ padding: '12px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid var(--warn)', borderRadius: '8px' }}>
                  <label style={{ color: 'var(--warn)' }}>⚠️ CAPTCHA Required - Please solve and paste token below</label>
                  <input value={captchaToken} onChange={e => setCaptchaToken(e.target.value)} placeholder="Enter CAPTCHA token here" />
                </div>
              )}

              <div className="btn-row" style={{ marginTop: '16px' }}>
                <button className="btn btn-primary" onClick={() => runSubmit(false)} disabled={submitting || !canSubmit}>
                  {submitting ? <><span className="spinner" />Submitting…</> : `▶ Submit Ticket`}
                </button>
                {submitResult?.captchaRequired && (
                  <button className="btn btn-danger" onClick={() => runSubmit(true)} disabled={submitting}>
                    🔄 Resubmit with CAPTCHA
                  </button>
                )}
                {!canSubmit && <span style={{ color: '#f59e0b', fontSize: 12, display: 'flex', alignItems: 'center' }}>⚠ Please extract params or provide manual cookies.</span>}
              </div>
            </div>
          </div>

          {submitResult && (
            <div className="card">
              <div className="card-header">Response</div>
              <div className="card-body">
                <div className="status-row">
                  <span className={`stat-chip${submitResult.success ? ' ok' : ' err'}`}>
                    {submitResult.success ? '✓ Success' : '✗ Failed'} — HTTP {submitResult.status}
                  </span>
                  {submitResult.captchaRequired && <span className="stat-chip warn">⚠️ CAPTCHA Required</span>}
                  {submitResult.captchaPersistData && <span className="stat-chip">persist_data extracted</span>}
                  {(submitResult as any).ticketId && <span className="stat-chip ok">🎫 Ticket ID: {(submitResult as any).ticketId}</span>}
                </div>
                <div className="form-group">
                  <label>Submitted to</label>
                  <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: '#4f8aff', padding: '6px 0' }}>{submitResult.submittedUrl}</div>
                </div>
                <div className="form-group">
                  <label>Submitted params</label>
                  <div className="response-box" style={{ maxHeight: 120 }}>{submitResult.submittedBody}</div>
                </div>
                <div className="form-group">
                  <label>Server Response (first 5KB)</label>
                  <div className="response-box">{submitResult.responseText}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ════════════════ LOGS PANEL ════════════════ */}
        <div className={`panel${activeTab === 'logs' ? ' active' : ''}`}>
          <div className="card" style={{ flex: 1 }}>
            <div className="card-header">📋 Agent Logs</div>
            <div className="card-body">
              <div className="terminal" ref={terminalRef}>
                {agentResult?.logs.length ? agentResult.logs.map((l, i) => (
                  <div key={i} className="log-line">
                    <span className="log-ts">{fmtTime(l.ts)}</span>
                    <span className={`log-lvl ${l.level}`} style={{ color: LOG_COLORS[l.level] ?? '#fff' }}>{l.level.toUpperCase()}</span>
                    <span className="log-msg">{l.message}</span>
                  </div>
                )) : <div className="empty">No logs yet. Run extraction to see logs.</div>}
              </div>
            </div>
          </div>
        </div>

        {/* ════════════════ NETWORK REQS PANEL ════════════════ */}
        <div className={`panel${activeTab === 'reqs' ? ' active' : ''}`}>
          <div className="card">
            <div className="card-header">🌐 Intercepted Facebook Requests ({agentResult?.interceptedRequests.length ?? 0})</div>
            <div className="card-body">
              {agentResult?.interceptedRequests.length ? agentResult.interceptedRequests.map((r, i) => (
                <div key={i} className="req-item">
                  <div className="req-url">
                    <span className="req-method">{r.method}</span>
                    {r.url}
                  </div>
                  {r.parsedParams && Object.keys(r.parsedParams).length > 0 && (
                    <div className="req-params">
                      {BIGPIPE_KEYS.filter(k => r.parsedParams![k]).map(k => (
                        <span key={k} style={{ marginRight: 8, color: '#7c5cfc' }}>
                          {k}=<span style={{ color: '#e2e4ef' }}>{String(r.parsedParams![k]).substring(0, 40)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )) : <div className="empty">No requests intercepted. Run extraction first.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
