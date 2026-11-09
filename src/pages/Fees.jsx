import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { isFeatureEnabled, getPrintHeader, getPrintFooter, getSchoolProfile, subscribeToChanges } from '../data/coreStore';
import { getStudents } from '../data/studentStore';
import { getFees, recordPayment, getFeeSummary, getMpesaLogs } from '../data/financeStore';
import { voidPayment, restorePayment, getStudentPayments, getCurrentPeriodDetails } from '../data/academicsStore';
import { TERM_FEE } from '../data/seedData';
import Loader from '../components/Common/Loader';
import { CLASSES, CBC_STRUCTURE } from '../data/seedData';
import { 
  CardIcon, RocketIcon, UserIcon, InfoIcon, SearchIcon, CheckIcon, ReceiptIcon, PrintIcon, AlertIcon, DashboardIcon, ClockIcon, SendIcon
} from '../components/CommonIcons';
import { printReceipt } from '../utils/receiptPrint';
// import MpesaReconciliation from './MpesaReconciliation'; // WIP: M-Pesa disabled
import Select from '../components/Common/Select';
import { Helmet } from 'react-helmet-async';
import FeatureGate from '../components/FeatureGate';
import { useDialog } from '../contexts/DialogContext';
import { dispatchSMS, generateFeeReminder } from '../utils/sms';
import { initiateStkPush } from '../utils/mpesa';

function PaymentModal({ student, fee, onPay, onClose }) {
  const { alert, confirm, toast } = useDialog();
  const { enabled: mpesaEnabled } = useFeature('mpesa');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('M-Pesa');
  const [reference, setReference] = useState('');
  const [phone, setPhone] = useState(student.parentPhone || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStkPushing, setIsStkPushing] = useState(false);
  const isNotConfigured = fee.totalFee === null; // New state detection

  const formatKSh = (n) => n === null ? 'Not Set' : `KSh ${Number(n||0).toLocaleString()}`;
  
  const handleSubmit = async (e) => { 
    e.preventDefault(); 
    if(!amount || Number(amount)<=0 || isSubmitting) return; 
    setIsSubmitting(true);
    try {
      await onPay(student.id, amount, method, reference); 
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStkPush = async () => {
    if (!amount || Number(amount) <= 0) {
      alert({ title: 'Invalid Amount', message: 'Please enter a valid amount for STK Push.', variant: 'warning' });
      return;
    }
    if (!phone) {
      alert({ title: 'Missing Phone', message: 'Parent phone number is required for STK Push.', variant: 'warning' });
      return;
    }

    setIsStkPushing(true);
    try {
      const res = await initiateStkPush({
        phoneNumber: phone,
        amount: Number(amount),
        accountRef: student.admNo,
        description: `Fees: ${student.name}`,
        studentId: student.id
      });

      if (res.success) {
        toast({ title: 'STK Push Accepted', message: 'Safaricom accepted the request. Ask the payer to check their phone; the fee ledger updates only after the payment callback is verified.', variant: 'success' });
        // We don't close yet, wait for manual confirmation or callback
      }
    } catch (err) {
      alert({ title: 'STK Push Failed', message: err.message, variant: 'danger' });
    } finally {
      setIsStkPushing(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{ maxWidth: 450 }}>
        <div className="modal-header">
          <h3><CardIcon size={20} /> Record Payment</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        {isNotConfigured ? (
          <div className="modal-body">
             <div style={{ textAlign: 'center', padding: '24px 10px' }}>
                <div style={{ fontSize: '3rem', marginBottom: 16 }}>⚙️</div>
                <h4 style={{ marginBottom: 8 }}>Fee Structure Required</h4>
                <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: 24 }}>
                  You must set the term fee for <strong>{student.class}</strong> before you can record payments.
                </p>
                <div style={{ background: '#fef2f2', padding: 16, borderRadius: 12, border: '1px solid #fecaca', textAlign: 'left', marginBottom: 20 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 800, color: '#991b1b', textTransform: 'uppercase', marginBottom: 10 }}>Action Required:</div>
                  <ol style={{ fontSize: '0.85rem', color: '#7f1d1d', paddingLeft: 18 }}>
                    <li>Go to <strong>Settings</strong> module.</li>
                    <li>Open the <strong>Student Fees</strong> tab.</li>
                    <li>Update the rate for <strong>{student.class}</strong>.</li>
                  </ol>
                </div>
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => window.location.hash='#/settings'}>
                   Go to Settings
                </button>
             </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              <div style={{background:'#f8fafc',borderRadius:8,padding:16,marginBottom:20}}>
                <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--primary)', marginBottom: 2 }}>{student.admNo}</div>
                <div className="flex-between"><span><strong>{student.name}</strong></span><span className="badge badge-info">{student.class}</span></div>
                <div className="flex-between mt-1" style={{fontSize:'0.85rem'}}><span className="text-muted">Balance:</span><span className="text-danger font-bold">{formatKSh(fee?.balance)}</span></div>
              </div>
              
              <div className="form-group"><label>Amount (KSh) *</label><input className="form-input" type="number" min="1" value={amount} onChange={e=>setAmount(e.target.value)} required placeholder="Enter amount"/></div>
              
              <div className="form-group">
                <label>Payment Method</label>
                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  {['M-Pesa', 'Cash', 'Bank'].map(m => (
                    <button 
                      key={m} 
                      type="button"
                      onClick={() => setMethod(m)}
                      className={`btn ${method === m ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ flex: 1, padding: '8px 0', fontSize: '0.8rem' }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {method === 'M-Pesa' && (
                <div style={{ background: 'var(--bg-alt)', padding: 16, borderRadius: 12, border: '1px solid var(--border)', marginBottom: 20 }}>
                  <label className="form-label" style={{ fontSize: '0.75rem', fontWeight: 700 }}>STK Push Number</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <input className="form-input" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="2547..." style={{ flex: 1 }} />
                    {mpesaEnabled ? (
                      <button 
                        type="button" 
                        className="btn btn-success" 
                        onClick={handleStkPush}
                        disabled={isStkPushing || !amount}
                        style={{ padding: '0 16px' }}
                      >
                        {isStkPushing ? '...' : 'STK Push'}
                      </button>
                    ) : (
                      <button 
                        type="button" 
                        className="btn btn-ghost" 
                        onClick={() => alert({ title: 'Premium Feature', message: 'M-Pesa STK Push is a Premium feature. Please upgrade your plan to automate collections.', variant: 'info' })}
                        style={{ padding: '0 16px', opacity: 0.6 }}
                      >
                        🔒 STK
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 8 }}>
                    Triggers a payment prompt on the parent's phone.
                  </p>
                </div>
              )}

              <div className="form-group"><label>Transaction Reference (Manual Entry)</label><input className="form-input" value={reference} onChange={e=>setReference(e.target.value)} placeholder="e.g. QWE1234567"/></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSubmitting}>Cancel</button>
              <button type="submit" className="btn btn-success" disabled={isSubmitting}><CheckIcon size={16} /> {isSubmitting ? 'Recording...' : 'Record Payment'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function HistoryModal({ student, onClose, onVoid, isAdmin }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const { confirm, prompt } = useDialog();

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getStudentPayments(student.id);
        setPayments(data);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
  }, [student.id]);

  const handleVoidClick = async (p) => {
    const reason = await prompt({
      title: 'Void Payment',
      message: `Are you sure you want to void the payment of KSh ${p.amount.toLocaleString()}? This will reverse the amount on the student's balance.`,
      inputLabel: 'Reason for voiding (required)',
      inputPlaceholder: 'e.g. Wrong student selected, duplicate entry...',
      confirmText: 'Void Payment',
      variant: 'danger'
    });

    if (reason) {
      setLoading(true);
      try {
        await onVoid(p.id, reason);
        // Refresh list
        setPayments(await getStudentPayments(student.id));
      } catch (e) {
        alert({ title: 'Void Failed', message: e.message, variant: 'danger' });
      } finally { setLoading(false); }
    }
  };

  const handleRestoreClick = async (p) => {
    const ok = await confirm({
      title: 'Restore Payment',
      message: `Restore the voided payment of KSh ${p.amount.toLocaleString()}? This will re-apply the amount to the student's balance.`,
      confirmText: 'Restore Payment',
      variant: 'warning'
    });
    if (ok) {
      setLoading(true);
      try {
        await restorePayment(p.id);
        setPayments(await getStudentPayments(student.id));
      } catch (e) {
        console.error(e);
      } finally { setLoading(false); }
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="modal-header">
          <h3><ClockIcon size={20} /> Payment History — {student.name}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
          {loading ? <div style={{ textAlign: 'center', padding: 20 }}>Loading history...</div> : (
            <table className="data-table" style={{ fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Ref</th>
                  <th>Method</th>
                  <th>Status</th>
                  {isAdmin && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 ? (
                  <tr><td colSpan="6" style={{ textAlign: 'center', padding: 20 }}>No payments found.</td></tr>
                ) : payments.map(p => (
                  <tr key={p.id} style={{ opacity: p.status === 'Voided' ? 0.5 : 1 }}>
                    <td>{new Date(p.date || p.created_at).toLocaleDateString()}</td>
                    <td className="font-bold">KSh {Number(p.amount).toLocaleString()}</td>
                    <td><code style={{ fontSize: '0.75rem' }}>{p.reference || 'N/A'}</code></td>
                    <td>{p.method}</td>
                    <td>
                      <span className={`badge ${p.status === 'Voided' ? 'badge-danger' : 'badge-success'}`} style={{ fontSize: '0.65rem' }}>
                        {p.status || 'Success'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td>
                        {p.status !== 'Voided' && (
                          <button className="btn btn-ghost btn-xs text-danger" onClick={() => handleVoidClick(p)}>Void</button>
                        )}
                        {p.status === 'Voided' && (
                          <button className="btn btn-ghost btn-xs text-success" onClick={() => handleRestoreClick(p)} style={{fontWeight:700}}>Restore</button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ReceiptModal({ receipt, onClose, profile }) {
  const formatKSh = (n) => `KSh ${Number(n||0).toLocaleString()}`;
  
  const billed = receipt.totalFee || 0;
  const currentPaid = receipt.amount || 0;
  const balance = receipt.balance || 0;
  const previousPaid = Math.max(0, billed - balance - currentPaid);

  const handlePrint = () => {
    printReceipt({
      school: {
        name: profile?.schoolName || '',
        location: profile?.address || 'Nairobi, Kenya',
        phone: profile?.phone || '',
        email: profile?.email || '',
        logo: profile?.logo
      },
      student: {
        name: receipt.studentName,
        admission_number: receipt.admNo,
        grade: receipt.studentClass
      },
      payment: {
        id: receipt.id,
        amount: receipt.amount,
        transaction_code: receipt.reference,
        created_at: receipt.date,
        method: receipt.method,
        balance: receipt.balance, // Passed from parent
        totalFee: receipt.totalFee
      }
    });
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:460}}>
        <div className="modal-header"><h3><ReceiptIcon size={20} /> Receipt</h3><button className="modal-close" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <div className="receipt">
            <div className="receipt-header"><h2>{profile?.schoolName || ''}</h2><p className="text-muted" style={{fontSize:'0.82rem'}}>Payment Receipt</p></div>
            <div className="receipt-row"><span>Receipt No:</span><strong>{receipt.id}</strong></div>
            <div className="receipt-row"><span>Date:</span><strong>{receipt.date}</strong></div>
            <div className="receipt-row"><span>Adm No:</span><strong>{receipt.admNo}</strong></div>
            <div className="receipt-row"><span>Student:</span><strong>{receipt.studentName}</strong></div>
            <div className="receipt-row"><span>Class:</span><strong>{receipt.studentClass}</strong></div>
            <div className="receipt-row"><span>Method:</span><strong>{receipt.method}</strong></div>
            {receipt.reference && <div className="receipt-row"><span>Ref:</span><strong>{receipt.reference}</strong></div>}
            
            <div className="receipt-divider" style={{ borderTop: '1px dashed #ccc', margin: '10px 0' }}></div>
            
            <div className="receipt-row"><span>Term Fee (Billed):</span><strong>{formatKSh(billed)}</strong></div>
            {previousPaid > 0 && <div className="receipt-row"><span>Previously Paid:</span><strong>{formatKSh(previousPaid)}</strong></div>}
            
            <div className="receipt-row receipt-total" style={{ borderTop: 'none', marginTop: 4, paddingTop: 4 }}>
              <span>Amount Paid Now:</span><strong style={{color:'var(--success)'}}>{formatKSh(currentPaid)}</strong>
            </div>

            <div className="receipt-row" style={{ marginTop: '12px', padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
               <span style={{color: '#64748b', fontWeight: 600}}>Outstanding Balance:</span>
               <strong style={{color: balance > 0 ? 'var(--danger)' : 'var(--success)', fontSize: '1.05rem'}}>{balance > 0 ? formatKSh(balance) : 'CLEARED'}</strong>
            </div>
          </div>
        </div>
        <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={handlePrint}><PrintIcon size={16} /> Print</button></div>
      </div>
    </div>
  );
}

import { useFeature } from '../contexts/FeaturesContext';

export default function Fees({ currentUser, currentPeriodId }) {
  const { alert, confirm } = useDialog();
  const [students, setStudents] = useState([]);
  const [fees, setFees] = useState({});
  const [summary, setSummary] = useState({});
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [showPayment, setShowPayment] = useState(null);
  const [showReceipt, setShowReceipt] = useState(null);
  const [showHistory, setShowHistory] = useState(null);
  const [profile, setProfile] = useState({});
  const [activePeriod, setActivePeriodState] = useState(null);
  const [streamFilter, setStreamFilter] = useState('All');
  const [loading, setLoading] = useState(true);
  // const [activeTab, setActiveTab] = useState('list'); // WIP: Only one tab now
  // const [mpesaLogs, setMpesaLogs] = useState([]);

  const { enabled: hasAccess, loading: featureLoading } = useFeature('fees');

  const isAdmin   = currentUser?.role?.toLowerCase() === 'admin';
  const isFinance = currentUser?.role?.toLowerCase() === 'finance';

  const refresh = useCallback(async () => {
    try {
      const [sData, fData, sumData, pData] = await Promise.all([
        getStudents(), 
        getFees(), 
        getFeeSummary(),
        getCurrentPeriodDetails()
      ]);
      setStudents(sData); 
      setFees(fData); 
      setSummary(sumData);
      setActivePeriodState(pData);
    } catch (err) { console.error(err); }
  }, []);

  useEffect(() => {
    const init = async () => {
      if (featureLoading) return;
      if (!hasAccess) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        setProfile(await getSchoolProfile());
        await refresh();
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    };
    init();

    if (hasAccess) {
      // Subscribe to real-time changes
      const unsubFees = subscribeToChanges('fees', refresh);
      const unsubPayments = subscribeToChanges('payments', refresh);

      return () => {
        unsubFees();
        unsubPayments();
      };
    }
  }, [currentPeriodId, hasAccess, featureLoading, refresh]);

  const formatKSh = (n) => `KSh ${Number(n||0).toLocaleString()}`;
  
  const computeStudentFee = useCallback((s) => {
    const record = fees[s.id];
    if (record) return { 
      totalFee: Number(record.totalFee), 
      paid: Number(record.paid), 
      balance: Number(record.balance),
      payments: record.payments
    };

    const classFees = profile.gradeFees?.[s.class];
    let totalBilled = null;
    if (classFees) {
      if (typeof classFees === 'object') {
        const resType = (s.residence_type || s.residenceType || 'day').toLowerCase();
        const termName = activePeriod?.term || null;
        if (termName && classFees[termName] && typeof classFees[termName] === 'object') {
          totalBilled = Number(classFees[termName][resType]) || Number(classFees[termName].day) || null;
        }
        if (!totalBilled) {
          totalBilled = Number(classFees[resType]) || Number(classFees.day) || null;
        }
      } else {
        totalBilled = Number(classFees) || null;
      }
    }
    return { totalFee: totalBilled, paid: 0, balance: totalBilled };
  }, [fees, profile, activePeriod]);

  const filtered = React.useMemo(() => {
    return students.filter(s => {
      const f = computeStudentFee(s);
      const ms = s.name.toLowerCase().includes(search.toLowerCase())||s.admNo.toLowerCase().includes(search.toLowerCase());
      const mc = classFilter==='All'||s.class===classFilter;
      const mstr = streamFilter==='All'||s.stream===streamFilter;
      let mst = true;
      if(statusFilter==='Paid') mst=(Number(f.balance)||0)<=0;
      else if(statusFilter==='Partial') mst=(Number(f.paid)||0)>0&&(Number(f.balance)||0)>0;
      else if(statusFilter==='Unpaid') mst=(Number(f.paid)||0)===0;
      return ms&&mc&&mstr&&mst;
    });
  }, [students, search, classFilter, streamFilter, statusFilter, computeStudentFee]);

  const printFeeList = useCallback(async () => {
    try {
      const list = filtered;
      const headerStr = await getPrintHeader(`Fee Report — ${classFilter} | ${streamFilter} | ${statusFilter}`);
      const footerStr = await getPrintFooter();
      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>Fee List - ${classFilter}</title>
      <style>@page{margin:0}body{font-family:Arial,sans-serif;padding:15mm}
      table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-size:13px}
      th{background:#1e3a5f;color:white}.footer{margin-top:30px;font-size:12px;color:#64748b}
      .text-success{color:#10b981}.text-danger{color:#ef4444}.font-bold{font-weight:700}</style></head><body>
      ${headerStr}
    <table><thead><tr><th>Adm No</th><th>Student</th><th>Class</th><th>Stream</th><th>Total Fee</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
    <tbody>${list.map(s => {
      const f = computeStudentFee(s);
      const st = f.balance <= 0 ? 'Paid' : f.paid > 0 ? 'Partial' : 'Unpaid';
      return `<tr><td>${s.admNo}</td><td><strong>${s.name}</strong></td><td>${s.class}</td><td>${s.stream||'—'}</td>
        <td>${formatKSh(f.totalFee)}</td><td class="text-success font-bold">${formatKSh(f.paid)}</td>
        <td class="${f.balance>0?'text-danger':'text-success'} font-bold">${formatKSh(f.balance)}</td>
        <td>${st}</td></tr>`;
    }).join('')}</tbody></table>
    <div class="footer">Printed on ${new Date().toLocaleDateString()}</div>
    ${footerStr}
    </body></html>`);
      w.document.close(); w.print();
    } catch(err){ alert({ title: 'Print Error', message: "Print failed: " + err.message, variant: 'danger' }); }
  }, [filtered, classFilter, streamFilter, statusFilter]);
  const handlePayment = async (sid,amount,method,ref) => {
    setLoading(true);
    try {
      const p = await recordPayment(sid,amount,method,ref);
      const s = students.find(x=>x.id===sid);
      const fee = (await getFees())[sid] || {};
      setShowReceipt({...p,studentName:s.name,studentClass:s.class,admNo:s.admNo,totalFee:fee.totalFee,balance:fee.balance});
      setShowPayment(null); 
      await refresh();
    } catch (err) { alert({ title: 'Payment Error', message: err.message, variant: 'danger' }); }
    finally { setLoading(false); }
  };

  const handleVoid = async (paymentId, reason) => {
    setLoading(true);
    try {
      await voidPayment(paymentId, reason);
      await refresh();
    } catch (err) {
      alert({ title: 'Void Error', message: err.message, variant: 'danger' });
      throw err; // Re-throw to allow HistoryModal to handle its loading state if needed
    } finally {
      setLoading(false);
    }
  };

  const handleSendReminder = async (s) => {
    const f = computeStudentFee(s);
    if (f.balance <= 0) {
      alert({ title: 'No Balance', message: 'Student has no outstanding fees.', variant: 'info' });
      return;
    }

    const ok = await confirm({
      title: 'Send Fee Reminder',
      message: `Send an SMS fee reminder for KSh ${f.balance.toLocaleString()} to ${s.name}'s parent?`,
      confirmText: 'Send Now',
      variant: 'primary'
    });

    if (ok) {
      setLoading(true);
      try {
        const msg = generateFeeReminder(s.name, f.balance);
        await dispatchSMS(s.parentPhone, msg);
        alert({ title: 'Reminder Sent', message: 'SMS reminder dispatched successfully.', variant: 'success' });
      } catch (err) {
        alert({ title: 'SMS Error', message: err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };

  if (featureLoading) return <Loader />;
  if (!hasAccess) return <FeatureGate featureName="Fees" />;

  return (
    <div className="animate-in">
      <Helmet>
        <title>Fee Collection & Billing | Termly — Finance Portal</title>
        <meta name="description" content="Manage school fee payments, M-Pesa reconciliation, and student financial records." />
      </Helmet>
      <div className="page-header">
        <div className="page-header-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '-0.5px' }}>Fees Tracking</h2>
              <p className="text-muted">Manage fee payments and balances</p>
            </div>
            {loading && <span className="text-muted" style={{ fontSize: '0.85rem' }}>Loading...</span>}
          </div>
          <button className="btn btn-ghost" onClick={printFeeList}><PrintIcon size={16} /> Print Fee List</button>
        </div>
      </div>
      <div className="kpi-grid">
        <div className="kpi-card green">
          <div className="kpi-icon green"><CardIcon size={20} /></div>
          <div className="kpi-value">{formatKSh(summary.totalCollected)}</div>
          <div className="kpi-label">Total Collected</div>
        </div>
        <div className="kpi-card red">
          <div className="kpi-icon red"><AlertIcon size={20} /></div>
          <div className="kpi-value">{formatKSh(summary.totalOutstanding)}</div>
          <div className="kpi-label">Outstanding Balance</div>
        </div>
        <div className="kpi-card blue">
          <div className="kpi-icon blue"><DashboardIcon size={20} /></div>
          <div className="kpi-value">{formatKSh(summary.totalExpected)}</div>
          <div className="kpi-label">Expected Revenue</div>
        </div>
        <div className="kpi-card purple">
          <div className="kpi-icon purple"><CheckIcon size={20} /></div>
          <div className="kpi-value">{summary.fullyPaid||0}</div>
          <div className="kpi-label">Fully Paid Students</div>
        </div>
      </div>
      
      {/* Configuration Warning Banner */}
      {students.some(s => computeStudentFee(s).totalFee === null) && (
        <div className="alert alert-warning" style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderRadius: 12 }}>
          <div style={{ fontSize: '1.5rem' }}>ℹ️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Some students have no fee configuration!</div>
            <p style={{ fontSize: '0.85rem', margin: 0, opacity: 0.9 }}>
              Payments cannot be recorded for classes without a set fee. 
              <a href="#/settings" style={{ marginLeft: 6, fontWeight: 700, color: 'inherit', textDecoration: 'underline' }}>Configure Fee Structure now</a>
            </p>
          </div>
        </div>
      )}

      {/* Fee List */}
      <div className="filter-bar">
        <div className="search-bar"><span className="search-icon"><SearchIcon size={16} /></span><input type="text" placeholder="Search student..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
        <Select 
          value={classFilter} 
          onChange={e=>{setClassFilter(e.target.value); setStreamFilter('All');}}
          options={[
            { id: 'All', label: 'All Classes' },
            ...Object.entries(CBC_STRUCTURE).flatMap(([levelName, levelData]) => {
              const activeInLevel = levelData.grades.filter(g => profile.activeClasses?.includes(g));
              return activeInLevel.map(g => ({ id: g, label: g }));
            })
          ]}
          style={{ minWidth: 150 }}
        />
        <Select 
          value={streamFilter} 
          onChange={e=>setStreamFilter(e.target.value)}
          options={[
            { id: 'All', label: 'All Streams' },
            ...(classFilter !== 'All' 
              ? (profile.streamsPerClass?.[classFilter] || [])
              : Array.from(new Set(
                  Object.entries(profile.streamsPerClass || {})
                    .filter(([cls]) => (profile.activeClasses || []).includes(cls))
                    .flatMap(([, streams]) => streams)
                ))
            ).map(stream => ({ id: stream, label: stream }))
          ]}
          style={{ minWidth: 140 }}
        />
        <Select 
          value={statusFilter} 
          onChange={e=>setStatusFilter(e.target.value)}
          options={[
            { id: 'All', label: 'All Status' },
            { id: 'Paid', label: 'Fully Paid' },
            { id: 'Partial', label: 'Partial' },
            { id: 'Unpaid', label: 'Unpaid' }
          ]}
          style={{ minWidth: 140 }}
        />
      </div>

      <div className="card">
        <div className="card-body" style={{padding:0}}>
          <table className="data-table responsive-table">
            <thead>
              <tr><th>Adm No</th><th>Student</th><th>Class</th><th>Total Fee</th><th>Paid</th><th>Balance</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {filtered.map(s=>{
                const f = computeStudentFee(s);
                const isNotConfigured = f.totalFee === null;
                const status = isNotConfigured ? 'Pending Setup' : (Number(f.balance) || 0) <= 0 ? 'Paid' : (Number(f.paid) || 0) > 0 ? 'Partial' : 'Unpaid';
                return(
                  <tr key={s.id}>
                    <td data-label="Adm No"><code style={{ fontSize: '0.85rem', color: 'var(--primary)', fontWeight: 700 }}>{s.admNo}</code></td>
                    <td data-label="Student"><strong>{s.name}</strong></td>
                    <td data-label="Class">{s.class}</td>
                    <td data-label="Total Fee">{formatKSh(f.totalFee)}</td>
                    <td data-label="Paid" className="text-success font-bold">{formatKSh(f.paid)}</td>
                    <td data-label="Balance">
                      {isNotConfigured ? (
                        <span className="badge badge-warning" style={{ fontSize: '0.7rem' }}>⚠️ Config Needed</span>
                      ) : (
                        <span className={`font-bold ${f.balance > 0 ? 'text-danger' : 'text-success'}`}>{formatKSh(f.balance)}</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${status==='Paid'?'badge-success':(status==='Partial'||status==='Pending Setup')?'badge-warning':'badge-danger'}`}>
                        {status}
                      </span>
                    </td>
                    <td data-label="Action">
                      <div className="inline-flex" style={{justifyContent:'inherit'}}>
                        {(f.balance > 0 || isNotConfigured) && (
                          <button className="btn btn-primary btn-sm" onClick={()=>setShowPayment(s)}>
                             {isNotConfigured ? <AlertIcon size={14} /> : <CardIcon size={14} />} {isNotConfigured ? 'Configure' : 'Pay'}
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={()=>setShowHistory(s)} title="View Payment History">
                          <ClockIcon size={14} />
                        </button>
                        {f.balance > 0 && (
                          <button className="btn btn-ghost btn-sm text-primary" onClick={()=>handleSendReminder(s)} title="Send SMS Reminder">
                            <SendIcon size={14} />
                          </button>
                        )}
                        {f.payments && f.payments.length > 0 && (
                          <button className="btn btn-ghost btn-sm" onClick={()=>setShowReceipt({...f.payments[f.payments.length-1],studentName:s.name,studentClass:s.class,admNo:s.admNo,totalFee:f.totalFee,balance:f.balance})} title="Last Receipt">
                            <ReceiptIcon size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {showPayment && <PaymentModal student={showPayment} fee={computeStudentFee(showPayment)} onPay={handlePayment} onClose={() => setShowPayment(null)} />}
      {showReceipt && <ReceiptModal receipt={showReceipt} profile={profile} onClose={() => setShowReceipt(null)} />}
      {showHistory && <HistoryModal student={showHistory} isAdmin={isAdmin} onVoid={handleVoid} onClose={() => setShowHistory(null)} />}
    </div>
  );
}
