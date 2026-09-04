'use client';
import React, { useState } from 'react';

export default function Page() {
  const [form, setForm] = useState({
    accountId: '',
    message: '',
    cookies: '',
    formUrl: 'https://www.facebook.com/help/contact/649167531904667'
  });
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Common Facebook support forms
  const forms = [
    { value: 'https://www.facebook.com/help/contact/391647094929792', label: 'Form 792 (Primary Payment) - WORKS' },
    { value: 'https://www.facebook.com/help/contact/1856425021037976', label: 'Form 976 - WORKS' },
    { value: 'https://www.facebook.com/help/contact/161710477317189', label: 'Form 189 - WORKS' },
    { value: 'https://www.facebook.com/help/contact/649167531904667', label: 'Form 667 (Payment Settings) - DEAD' },
    { value: 'https://www.facebook.com/help/contact/13', label: 'Form 13' }
  ];

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    setStatus(null);
    setLoading(true);
    try {
      const finalFormUrl = form.formUrl === 'custom' ? 
        (form as any).customUrl || 'https://www.facebook.com/help/contact/649167531904667' : 
        form.formUrl;
      
      const res = await fetch('/api/facebook/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 9222,
          accountId: form.accountId,
          message: form.message,
          cookies: form.cookies.trim() || undefined,
          formUrl: finalFormUrl
        })
      });
      const data = await res.json();
      setStatus(data);
    } catch (err: any) {
      setStatus({ success: false, error: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem'
    }}>
      <div style={{ width: '100%', maxWidth: '500px' }}>
        <h1 style={{ fontSize: '1.75rem', marginBottom: '1.5rem', color: '#fff' }}>Facebook Support Automation</h1>
        
        <form onSubmit={handleSubmit} style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          padding: '1.5rem',
          borderRadius: '12px',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)'
        }}>
          
          {/* Account ID */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: '#cbd5e1' }}>Account ID</label>
            <input 
              value={form.accountId} 
              onChange={(e: any) => setForm({...form, accountId: e.target.value})} 
              placeholder="e.g. 123456789" 
              style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid #475569', backgroundColor: '#0f172a', color: '#fff', boxSizing: 'border-box' }} 
              required
            />
          </div>
          
          {/* Message */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: '#cbd5e1' }}>Message</label>
            <textarea 
              value={form.message} 
              onChange={(e: any) => setForm({...form, message: e.target.value})} 
              placeholder="Support requested..." 
              rows={3} 
              style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid #475569', backgroundColor: '#0f172a', color: '#fff', boxSizing: 'border-box', resize: 'vertical' }} 
              required
            ></textarea>
          </div>
          
          {/* Cookies */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: '#cbd5e1' }}>Cookies (optional)</label>
            <input 
              value={form.cookies} 
              onChange={(e: any) => setForm({...form, cookies: e.target.value})} 
              placeholder="Leave blank if Chrome is open on port 9222" 
              style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid #475569', backgroundColor: '#0f172a', color: '#fff', boxSizing: 'border-box' }} 
            />
            <small style={{ display: 'block', marginTop: '0.3rem', fontSize: '0.75rem', color: '#94a3b8' }}>
              Leave blank if Chrome is open with Facebook login on port 9222
            </small>
          </div>
          
          {/* Support Form URL */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: '#cbd5e1' }}>Support Form</label>
            <select 
              value={form.formUrl} 
              onChange={(e: any) => setForm({...form, formUrl: e.target.value})} 
              style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid #475569', backgroundColor: '#0f172a', color: '#fff', boxSizing: 'border-box' }}
            >
              {forms.map(f => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          
          {/* Submit Button */}
          <button type="submit" disabled={loading} style={{
            width: '100%', 
            padding: '0.75rem', 
            background: loading ? '#2563eb' : '#3b82f6', 
            color: 'white', 
            border: 'none', 
            borderRadius: '6px', 
            cursor: loading ? 'not-allowed' : 'pointer', 
            display: 'flex', 
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: '600',
            fontSize: '1rem',
            transition: 'background 0.2s'
          }}>
            {loading ? (
              <><span style={{animation: 'spin 0.8s linear infinite', width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', display: 'inline-block', marginRight: '8px'}}></span> Submitting...</>
            ) : (
              <span style={{marginRight: '0.5rem'}}>📤 Submit Ticket</span>
            )}
          </button>
        </form>

        {/* Status Messages */}
        {status && (
          <div style={{
            marginTop: '1.5rem', 
            padding: '1rem', 
            borderRadius: '8px', 
            fontSize: '0.9rem',
            backgroundColor: status.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${status.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
          }}>
            {status.success ? (
              <p style={{ margin: 0, color: '#4ade80' }}><strong>✅ Success:</strong> HTTP {status.status === 200 ? '200' : status.status}</p>
            ) : (
              <p style={{ margin: 0, color: '#f87171' }}>
                <strong>❌ Error:</strong> {status.error || status.response || 'Unknown error'}
              </p>
            )}
          </div>
        )}
        
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          button:hover:not(:disabled) {
            background-color: #2563eb !important;
          }
          input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: #3b82f6 !important;
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2) !important;
          }
        `}} />
      </div>
    </div>
  );
}