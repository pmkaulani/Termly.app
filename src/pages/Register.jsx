import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { registerSchool, getPlatformSettings } from '../data/coreStore';;
import { checkSchoolExists } from '../data/authStore';
import { 
  BookIcon, CardIcon, SchoolIcon, FlagIcon, ClockIcon, RocketIcon, CheckIcon, HomeIcon,
  EyeIcon, EyeOffIcon
} from '../components/CommonIcons';
import { SANDBOX_PLAN } from '../data/constants';
import { Helmet } from 'react-helmet-async';
import { useDialog } from '../contexts/DialogContext';
import Select from '../components/Common/Select';

export default function Register() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [lastResent, setLastResent] = useState(0);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [settings, setSettings] = useState(null);
  const { alert } = useDialog();

  const [formData, setFormData] = useState({
    schoolName: '',
    schoolEmail: '',
    plan: SANDBOX_PLAN, 
    adminName: '',
    password: '',
    phone: '',
    location: '',
    curriculum: 'CBC Only', 
    termsAccepted: false // L-5: Do not auto-accept terms for KDPA compliance
  });

  useEffect(() => {
    async function loadSettings() {
      const s = await getPlatformSettings();
      setSettings(s);
      
      // Ownership Check: If already signed in, check if they own a school
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const { data: existing } = await supabase.from('schools').select('id').eq('owner_id', session.user.id).maybeSingle();
        if (existing) {
          setError("You already own a school workspace. Multi-school registration is restricted.");
          setStep(3); // Go to success/info screen
          setSuccess(true);
        }
      }

      if (s?.pricing && !s.pricing[formData.plan]) {
        const firstPlan = Object.entries(s.pricing).find(([_, p]) => p.active !== false)?.[0];
        if (firstPlan) setFormData(prev => ({ ...prev, plan: firstPlan }));
      }
    }
    loadSettings();
  }, []);

  // 1. Persistence: Restore state from sessionStorage on mount
  useEffect(() => {
    const savedData = sessionStorage.getItem('Termly_reg_form');
    const savedStep = sessionStorage.getItem('Termly_reg_step');
    if (savedData) setFormData(prev => ({ ...prev, ...JSON.parse(savedData) }));
    if (savedStep) setStep(Number(savedStep));
  }, []);

  // 2. Persistence: Save state to sessionStorage when it changes
  useEffect(() => {
    if (step < 3) {
      // Exclude sensitive fields like password
      const { password, ...safeData } = formData;
      sessionStorage.setItem('Termly_reg_form', JSON.stringify(safeData));
      sessionStorage.setItem('Termly_reg_step', step.toString());
    } else {
      // Clear storage on success or if we reach the end
      sessionStorage.removeItem('Termly_reg_form');
      sessionStorage.removeItem('Termly_reg_step');
    }
  }, [formData, step]);


  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({ 
      ...formData, 
      [name]: type === 'checkbox' ? checked : value 
    });
  };

  const handleNext = (nextStep) => {
    if (step === 1 && (!formData.schoolName || !formData.schoolEmail || !formData.phone || !formData.location)) {
      setError("Please provide all school identity and contact details.");
      return;
    }
    setError(null);
    setStep(nextStep);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!formData.termsAccepted) {
      setError("Please accept the Terms and Privacy Policy.");
      return;
    }

    if (getPasswordStrength() < 4) {
      setError('Password is too weak. Please use at least 8 characters, a number, an uppercase letter, and a special character.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let authUserId = null;

      // 0. Check if already signed in
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        authUserId = session.user.id;
      } else {
        // 1. Attempt to sign up the user in Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: formData.schoolEmail,
          password: formData.password,
          options: {
            data: { full_name: formData.adminName },
            emailRedirectTo: `${window.location.origin}/login`
          }
        });

        if (authError) {
          // If user already exists in Auth, try signing in instead
          if (authError.message?.toLowerCase().includes('already registered') || 
              authError.message?.toLowerCase().includes('already been registered') ||
              authError.message?.toLowerCase().includes('user already exists')) {
            
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
              email: formData.schoolEmail,
              password: formData.password,
            });

            if (signInError) {
              throw new Error('An account with this email already exists with a different password. Please use the correct password or reset it.');
            }
            authUserId = signInData.user.id;
          } else {
            throw authError;
          }
        } else {
          authUserId = authData?.user?.id;
        }
      }

      if (!authUserId) {
        throw new Error('Could not establish authentication session. Please try again.');
      }

      // 2. Check if a school already exists for this user (by owner_id)
      const existingSchool = await checkSchoolExists(authUserId);

      if (existingSchool) {
        // School already exists — take them to success or redirect
        setSuccess(true);
        setStep(3);
        return;
      }

      // 3. Register the school workspace (Creates school, profile, logic)
      await registerSchool(
        formData.schoolName,
        formData.schoolEmail,
        SANDBOX_PLAN,
        authUserId,
        formData.adminName,
        formData.schoolEmail,
        formData.phone,
        formData.location,
        formData.curriculum
      );

      setSuccess(true);
      setStep(3); // Success screen
    } catch (err) {
      setError(err.message || 'An unexpected error occurred during registration.');
    } finally {
      setLoading(false);
    }
  };

  const getPasswordStrength = () => {
    const v = formData.password;
    let s = 0;
    if (v.length >= 8) s++;
    if (/[A-Z]/.test(v)) s++;
    if (/[0-9]/.test(v)) s++;
    if (/[^A-Za-z0-9]/.test(v)) s++;
    return s;
  };

  return (
    <div className="res-page">
      <Helmet>
        <title>Register Your School | Termly — Free School Workspace</title>
        <meta name="description" content="Register your school on Termly for free. Get an Official workspace to explore CBC grading, fee tracking, and all modules instantly." />
        <link rel="canonical" href="https://Termly.com/register" />
      </Helmet>
      <div className="card">
        {/* RIGHT PANEL - DECORATIVE */}
        <div className="right-panel">
          <div className="blob b1"></div>
          <div className="blob b2"></div>
          <div className="blob b3"></div>
          
          <div className="fblocks">
            <div className="fb">
              <span className="fb-ico"><BookIcon size={16} color="#fff" /></span>
              <div className="fb-t">CBC & 8-4-4 Ready</div>
              <div className="fb-d">Full KNEC-aligned portfolios & secondary grading.</div>
              <div className="fb-stat">
                <div><div className="fb-n">3hrs</div><div className="fb-l">saved per teacher / term</div></div>
                <div className="fb-badge">KNEC Ready</div>
              </div>
            </div>
            <div className="fb">
              <span className="fb-ico"><CardIcon size={16} color="#fff" /></span>
              <div className="fb-t">Fee Tracking</div>
              <div className="fb-d">Manage collections with professional receipts and instant statements.</div>
              <div className="fb-stat">
                <div><div className="fb-n">+18%</div><div className="fb-l">collection efficiency</div></div>
                <div className="fb-badge">Finance</div>
              </div>
            </div>
            <div className="fb">
              <span className="fb-ico"><SchoolIcon size={16} color="#fff" /></span>
              <div className="fb-t">200+ Schools</div>
              <div className="fb-d">Trusted across Nairobi, Kisumu, and Mombasa every day.</div>
              <div className="fb-stat">
                <div><div className="fb-n">48K</div><div className="fb-l">student records</div></div>
                <div className="fb-badge"><FlagIcon size={10} color="#fff" /> Kenya</div>
              </div>
            </div>
          </div>

          <div className="brand-stack">
            <div className="brand-n">
              Termly
            </div>
            <div className="brand-sub">The School Management System for modern Kenya <FlagIcon size={10} /></div>
          </div>
        </div>

        {/* LEFT PANEL - FORM */}
        <div className="left-panel">
          <Link to="/" className="res-back-link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5m7 7-7-7 7-7"/></svg>
            Back to Website
          </Link>

          <Link to="/" className="res-logo">
            <div className="logo-sq">
              <svg viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1.2" fill="white"/>
                <rect x="8" y="1" width="5" height="5" rx="1.2" fill="rgba(255,255,255,.55)"/>
                <rect x="1" y="8" width="5" height="5" rx="1.2" fill="rgba(255,255,255,.55)"/>
                <rect x="8" y="8" width="5" height="5" rx="1.2" fill="rgba(255,255,255,.25)"/>
              </svg>
            </div>
            Termly
          </Link>

          {step < 3 && (
            <>
              <div className="res-steps">
                <div className={`res-step ${step >= 1 ? 'done' : 'now'}`}>{step > 1 ? <CheckIcon size={12} color="#fff" /> : '1'}</div>
                <div className={`res-line ${step >= 2 ? 'done' : ''}`}></div>
                <div className={`res-step ${step >= 2 ? 'done' : step === 2 ? 'now' : 'todo'}`}>2</div>
              </div>
              <div className="res-slbls">
                <span className={`res-slbl ${step === 1 ? 'now' : ''}`}>School Profile</span>
                <span className={`res-slbl ${step === 2 ? 'now' : ''}`}>Account Setup</span>
              </div>
            </>
          )}

          {error && <div className="res-error">{error}</div>}

          {/* STEP 1: IDENTITY */}
          {step === 1 && (
            <div className="res-sv active">
              <div className="res-ftitle">Register Your School</div>
              <p className="res-fsub">Modernize your institution with Kenya's leading school management system.</p>

              <div className="res-sec-lbl">School Identity</div>
              <div className="res-field">
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M3 21v-2a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v2"/>
                    <path d="M12 3L2 9h20L12 3z"/>
                    <rect x="9" y="13" width="6" height="8"/>
                  </svg>
                </div>
                <input type="text" name="schoolName" placeholder="e.g. Alliance High School" value={formData.schoolName} onChange={handleChange} required />
                <div className="res-uline"></div>
              </div>
              <div className="res-field">
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="m2 7 10 7 10-7"/>
                  </svg>
                </div>
                <input type="email" name="schoolEmail" placeholder="info@school.ac.ke" value={formData.schoolEmail} onChange={handleChange} required />
                <div className="res-uline"></div>
              </div>

              <div className="res-field">
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                  </svg>
                </div>
                <input type="tel" name="phone" placeholder="School Phone (e.g. 0712...)" value={formData.phone} onChange={handleChange} required />
                <div className="res-uline"></div>
              </div>

              <div className="res-field">
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                  </svg>
                </div>
                <input type="text" name="location" placeholder="Physical Location (e.g. Nairobi, CBD)" value={formData.location} onChange={handleChange} required />
                <div className="res-uline"></div>
              </div>

              <div className="res-sec-lbl">Curriculum Focus</div>
              <div className="res-field" style={{ marginBottom: 32 }}>
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <Select 
                  name="curriculum"
                  value={formData.curriculum}
                  onChange={handleChange}
                  options={[
                    { value: 'CBC Only', label: 'CBC Only (Primary)' },
                    { value: '8-4-4 Only', label: '8-4-4 Only (Legacy)' },
                    { value: 'Mixed/Dual Mode', label: 'Mixed/Dual Mode (Secondary)' }
                  ]}
                  style={{ width: '100%' }}
                  className="res-custom-select"
                />
                <div className="res-uline" style={{ width: '100%' }}></div>
              </div>

              <button className="res-cta" onClick={() => handleNext(2)}>
                Next: Admin Details
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          )}

          {/* STEP 2: ADMIN & SECURITY */}
          {step === 2 && (
            <div className="res-sv active">
              <div className="res-ftitle">Administrator Setup</div>
              <p className="res-fsub">This account will have full access to manage your school's workspace.</p>

              <div className="res-field">
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </div>
                <input type="text" name="adminName" placeholder="Full name" value={formData.adminName} onChange={handleChange} required />
                <div className="res-uline"></div>
              </div>
              <div className="res-fhint">This will be your primary School Admin account.</div>
              
              <div className="res-field">
                <div className="res-fico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="3" y="11" width="18" height="11" rx="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <input 
                  type={showPassword ? "text" : "password"} 
                  name="password" 
                  placeholder="Create a secure password" 
                  value={formData.password} 
                  onChange={handleChange} 
                  required 
                  style={{ letterSpacing: showPassword ? 'normal' : '0.3em' }}
                />
                <button 
                  type="button" 
                  className="res-eye" 
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
                </button>
                <div className="res-uline"></div>
              </div>

              {formData.password && (
                <div className="res-pw-strength" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ flex: 1, height: 4, background: '#E8E8F0', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${(getPasswordStrength() / 4) * 100}%`,
                      background: getPasswordStrength() < 2 ? '#EF4444' : getPasswordStrength() < 3 ? '#F59E0B' : '#10B981',
                      transition: 'all 0.3s ease'
                    }}></div>
                  </div>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6B7280', width: 40, textAlign: 'right' }}>
                    {getPasswordStrength() < 2 ? 'Weak' : getPasswordStrength() < 4 ? 'Fair' : 'Strong'}
                  </span>
                </div>
              )}


              <div className="res-check-row" style={{ marginTop: 20 }}>
                <input 
                  type="checkbox" 
                  name="termsAccepted" 
                  id="termsAccepted"
                  checked={formData.termsAccepted} 
                  onChange={handleChange} 
                />
                <label htmlFor="termsAccepted" style={{ cursor: 'pointer' }}>
                  <span>I agree to the <Link to="/legal/terms" target="_blank" rel="noopener noreferrer">Terms of Service</Link> and <Link to="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</Link>.</span>
                </label>
              </div>

              <div className="res-btn-row" style={{ marginTop: 24 }}>
                <button className="res-btn-back" onClick={() => setStep(1)}>← Back</button>
                <button className="res-cta" disabled={loading} onClick={handleSubmit}>
                  {loading ? <><ClockIcon size={16} /> Creating Account...</> : <>Launch Workspace <RocketIcon size={16} /></>}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: SUCCESS */}
          {step === 3 && (
            <div className="res-sv active success-screen">
              <div className="success-icon"><RocketIcon size={64} color="var(--primary)" /></div>
              <div className="res-ftitle">{error ? 'Workspace Exists' : 'Registration Successful!'}</div>
              <p className="res-fsub">
                {error 
                  ? 'You already have an active school workspace. Please proceed to your dashboard.' 
                  : <>Your school <strong>{formData.schoolName}</strong> has been registered on Termly.</>
                }
              </p>
              
              <div className="success-box" style={{ textAlign: 'center' }}>
                {error ? (
                  <Link to="/dashboard" className="res-cta success-cta">Go to Dashboard</Link>
                ) : (
                  <>
                    <p style={{ textAlign: 'left' }}>An activation email has been sent to your <strong>School Email:</strong><br/><strong>{formData.schoolEmail}</strong></p>
                    
                    <div style={{ marginTop: 20, padding: 16, background: 'rgba(91, 62, 245, 0.05)', borderRadius: 12, border: '1px solid rgba(91, 62, 245, 0.1)', textAlign: 'left' }}>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--primary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>💡</span> Didn't get the email?
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem', color: '#6B7280', lineHeight: 1.5 }}>
                    <li>Check your <strong>Spam/Junk</strong> folder.</li>
                    <li>Wait ~5 minutes for delivery.</li>
                    <li>Look for sender <code>noreply@mail.supabase.co</code>.</li>
                  </ul>
                  <button 
                    onClick={async () => {
                      if (Date.now() - lastResent < 60000) return;
                      setResendLoading(true);
                      try {
                        const { error } = await supabase.auth.resend({ type: 'signup', email: formData.schoolEmail });
                        if (error) throw error;
                        setLastResent(Date.now());
                        await alert({ title: 'Email Resent', message: 'Activation email has been resent to your inbox.', variant: 'success' });
                      } catch (e) { await alert({ title: 'Resend Failed', message: e.message, variant: 'danger' }); }
                      finally { setResendLoading(false); }
                    }}
                    disabled={resendLoading || (Date.now() - lastResent < 60000)}
                    style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', padding: 0 }}
                  >
                    {resendLoading ? 'Sending...' : '→ Resend Activation Email'}
                  </button>
                </div>

                    <p style={{ marginTop: 16, opacity: 0.8, fontSize: '0.85rem' }}>This school email will be your <strong>School Admin</strong> login ID.</p>
                    <Link to="/login" className="res-cta success-cta">Proceed to Login</Link>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="res-bottom">
            <span>Already have an account? <Link to="/login">Log In</Link></span>
          </div>
        </div>
      </div>

      <style>{`
        .res-page {
          background: linear-gradient(135deg, #C7C4FF 0%, #A5B4FC 45%, #93C5FD 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 28px;
          color: #111118;
          font-family: 'Inter', sans-serif;
        }

        .card {
          position: relative;
          width: 100%;
          max-width: 900px;
          min-height: 640px;
          background: white;
          border-radius: 26px;
          overflow: hidden;
          box-shadow: 0 40px 90px rgba(70, 50, 200, .25), 0 8px 24px rgba(0, 0, 0, .12);
          display: flex;
          animation: cardIn .7s cubic-bezier(.16, 1, .3, 1) both;
        }

        @keyframes cardIn {
          from { opacity: 0; transform: translateY(36px) scale(.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* RIGHT PANEL */
        .right-panel {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 42%;
          background: linear-gradient(148deg, #4A32E0 0%, #6155FF 30%, #3B8BEB 68%, #29C6D4 100%);
          overflow: hidden;
        }

        .blob {
          position: absolute;
          animation: morph 11s ease-in-out infinite;
        }
        .b1 { width: 480px; height: 480px; bottom: -130px; right: -90px; background: rgba(41, 198, 212, .35); border-radius: 60% 40% 70% 30%/50% 60% 40% 50%; }
        .b2 { width: 220px; height: 220px; top: 20px; right: 40px; background: rgba(255, 255, 255, .07); border-radius: 40% 60% 30% 70%; animation-delay: -4s; }
        .b3 { width: 130px; height: 130px; top: 55%; right: 36%; background: rgba(107, 85, 255, .28); border-radius: 50%; animation-delay: -7s; }

        @keyframes morph {
          0%, 100% { border-radius: 60% 40% 70% 30%/50% 60% 40% 50%; }
          50% { border-radius: 30% 70% 50% 50%/30% 50% 50% 70%; }
        }

        .fblocks {
          position: relative;
          z-index: 3;
          padding: 0 24px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
        }

        .fb {
          background: rgba(255, 255, 255, .13);
          backdrop-filter: blur(14px);
          border: 1px solid rgba(255, 255, 255, .22);
          border-radius: 15px;
          padding: 14px 16px;
          animation: fbob 5s ease-in-out infinite;
        }
        .fb:nth-child(2) { animation-delay: 1.7s; }
        .fb:nth-child(3) { animation-delay: 3.4s; }

        @keyframes fbob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }

        .fb-ico { font-size: 16px; margin-bottom: 5px; display: block; }
        .fb-t { font-family: 'Epilogue', sans-serif; font-size: .8rem; font-weight: 800; color: #fff; margin-bottom: 2px; }
        .fb-d { font-size: .65rem; color: rgba(255, 255, 255, .7); line-height: 1.5; }
        .fb-stat {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(255, 255, 255, .12);
        }
        .fb-n { font-family: 'Epilogue', sans-serif; font-size: .9rem; font-weight: 800; color: #fff; }
        .fb-l { font-size: .55rem; color: rgba(255, 255, 255, .5); }
        .fb-badge { padding: 2px 8px; border-radius: 100px; font-size: .55rem; font-weight: 600; background: rgba(255, 255, 255, .18); color: rgba(255, 255, 255, .9); }

        .brand-stack {
          position: absolute;
          bottom: 24px;
          left: 0;
          right: 0;
          z-index: 3;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .brand-n { font-family: 'Epilogue', sans-serif; font-weight: 900; font-size: .9rem; color: #fff; display: flex; align-items: center; gap: 6px; }
        .brand-sq { width: 18px; height: 18px; border-radius: 5px; background: rgba(255, 255, 255, .2); display: flex; align-items: center; justify-content: center; }
        .brand-sub { font-size: .57rem; color: rgba(255, 255, 255, .5); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.1em; }

        /* LEFT PANEL */
        .left-panel {
          position: relative;
          z-index: 2;
          flex: 1;
          background: #fff;
          padding: 38px 48px;
          display: flex;
          flex-direction: column;
          clip-path: polygon(0 0, 95% 0, 100% 5%, 100% 95%, 95% 100%, 0 100%);
          max-height: 640px;
          overflow-y: auto;
        }

        .res-logo {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: 'Epilogue', sans-serif;
          font-weight: 900;
          font-size: 1.1rem;
          color: #111118;
          text-decoration: none;
          margin-bottom: 20px;
        }

        .res-back-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 0.7rem;
          font-weight: 700;
          color: #B0B7C3;
          text-decoration: none;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 12px;
          transition: color .2s;
        }
        .res-back-link:hover { color: #5B3EF5; }
        .res-back-link svg { width: 12px; height: 12px; }
        .logo-sq {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          background: #5B3EF5;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(91, 62, 245, .4);
        }
        .logo-sq svg { width: 14px; height: 14px; }

        .res-steps { display: flex; align-items: center; margin-bottom: 8px; width: 100%; max-width: 280px; }
        .res-step {
          width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid #E8E8F0;
          display: flex; align-items: center; justify-content: center;
          font-size: .8rem; font-weight: 700; font-family: 'Epilogue', sans-serif;
          color: #B0B7C3; transition: all .3s;
        }
        .res-step.done, .res-step.now { background: #5B3EF5; border-color: #5B3EF5; color: #fff; box-shadow: 0 4px 12px rgba(91, 62, 245, .3); }
        .res-line { flex: 1; height: 1.5px; background: #E8E8F0; margin: 0 8px; transition: background .3s; }
        .res-line.done { background: #5B3EF5; }

        .res-slbls { display: flex; justify-content: space-between; margin-bottom: 32px; width: 100%; max-width: 300px; }
        .res-slbl { font-size: .6rem; color: #B0B7C3; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
        .res-slbl.now { color: #5B3EF5; font-weight: 700; }

        .res-sv { animation: sIn .3s cubic-bezier(.16, 1, .3, 1) both; }
        @keyframes sIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }

        .res-ftitle { font-family: 'Epilogue', sans-serif; font-size: 1.6rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 6px; }
        .res-fsub { font-size: .9rem; color: #6B7280; margin-bottom: 24px; line-height: 1.6; }

        .res-sec-lbl { font-family: 'Epilogue', sans-serif; font-size: .65rem; font-weight: 700; color: #111118; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 12px; }

        .res-plans { display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px; }
        .res-plan {
          display: flex; align-items: center; gap: 12px; padding: 14px;
          border-radius: 14px; border: 1.5px solid #E8E8F0;
          cursor: pointer; transition: all .2s;
        }
        .res-plan:hover { border-color: #C4B5FF; background: #F9F9FF; }
        .res-plan.sel { border-color: #5B3EF5; background: #EEE9FF; }

        .res-prad { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #E8E8F0; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .res-plan.sel .res-prad { border-color: #5B3EF5; background: #5B3EF5; }
        .res-plan.sel .res-prad::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #fff; }

        .res-pname { font-family: 'Epilogue', sans-serif; font-size: .9rem; font-weight: 700; color: #111118; }
        .res-pprice { font-size: .75rem; color: #6B7280; }
        .res-pbadge { margin-left: auto; padding: 2px 10px; border-radius: 100px; font-size: .6rem; font-weight: 700; background: #5B3EF5; color: #fff; }

        .res-field { position: relative; margin-bottom: 24px; }
        .res-fico { position: absolute; left: 0; top: 12px; color: #B0B7C3; width: 20px; transition: color .2s; }
        .res-fico svg { width: 16px; height: 16px; }

        .res-field input {
          width: 100%; padding: 10px 0 10px 30px; border: none;
          border-bottom: 1.5px solid #E8E8F0; background: transparent;
          font-family: 'Inter', sans-serif; font-size: .95rem; outline: none; transition: border-color .3s;
        }
        .res-field input:focus { border-color: #5B3EF5; }
        .res-field input:focus + .res-uline { width: 100%; }
        .res-field input::placeholder { color: #B0B7C3; }

        .res-uline { position: absolute; bottom: 0; left: 0; height: 1.5px; width: 0; background: #5B3EF5; transition: width .3s; pointer-events: none; }
        .res-fhint { font-size: .7rem; color: #B0B7C3; margin-top: 6px; padding-left: 30px; }

        .res-pw-bar { height: 4px; border-radius: 2px; background: #E8E8F0; margin-top: 8px; margin-left: 30px; overflow: hidden; }
        .res-pw-fill { height: 100%; width: 0; transition: all .4s; }

        /* Custom Select Overrides */
        .res-custom-select .custom-select-trigger {
          background: transparent !important;
          border: none !important;
          border-radius: 0 !important;
          padding: 10px 0 10px 30px !important;
          box-shadow: none !important;
          font-size: .95rem !important;
          color: #111118 !important;
          font-weight: 400 !important;
        }
        .res-custom-select .custom-select-trigger:hover {
          background: rgba(91, 62, 245, 0.02) !important;
        }
        .res-custom-select .custom-select-trigger.open {
          color: #5B3EF5 !important;
        }

        .res-btn-row { display: flex; gap: 12px; margin-top: 8px; }
        .res-cta {
          flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
          padding: 14px 24px; border-radius: 100px; background: #5B3EF5; color: #fff;
          font-weight: 700; border: none; cursor: pointer; transition: all .25s;
          box-shadow: 0 6px 20px rgba(91, 62, 245, .3); font-family: 'Inter', sans-serif; font-size: .9rem;
        }
        .res-cta:hover:not(:disabled) { background: #4A32D4; transform: translateY(-1px); box-shadow: 0 10px 32px rgba(91, 62, 245, .4); }
        .res-cta:disabled { opacity: 0.7; cursor: not-allowed; }

        .res-eye {
          position: absolute; right: 0; top: 10px; background: none; border: none;
          color: #B0B7C3; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;
          transition: color .2s; z-index: 10;
        }
        .res-eye:hover { color: #5B3EF5; }
        .res-eye svg { width: 16px; height: 16px; }

        .res-btn-back { padding: 14px 20px; border-radius: 100px; background: #F3F4F6; color: #6B7280; font-weight: 600; border: none; cursor: pointer; font-size: .9rem; }

        .res-error { background: #FEE2E2; color: #B91C1C; padding: 12px 16px; border-radius: 12px; font-size: .85rem; font-weight: 600; margin-bottom: 20px; text-align: center; }

        .res-summary { background: #F9FAFB; border: 1.5px solid #E8E8F0; border-radius: 16px; padding: 18px; margin-bottom: 24px; }
        .res-sum-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #E8E8F0; }
        .res-sum-t { font-family: 'Epilogue', sans-serif; font-size: .9rem; font-weight: 700; color: #111118; }
        .res-sum-e { font-size: .75rem; color: #5B3EF5; background: none; border: none; cursor: pointer; font-weight: 600; }
        .res-sum-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .res-sum-k { font-size: .6rem; text-transform: uppercase; color: #B0B7C3; font-weight: 700; letter-spacing: 0.05em; margin-bottom: 4px; }
        .res-sum-v { font-size: .85rem; font-weight: 600; color: #111118; }

        .res-check-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 24px; cursor: pointer; }
        .res-check-row input { margin-top: 3px; accent-color: #5B3EF5; width: 16px; height: 16px; }
        .res-check-row span { font-size: .8rem; color: #6B7280; line-height: 1.5; }
        .res-check-row a { color: #5B3EF5; font-weight: 600; text-decoration: none; }

        .success-screen { text-align: center; padding: 20px 0; }
        .success-icon { font-size: 4rem; margin-bottom: 16px; display: block; }
        .success-box { background: #F3F4F6; padding: 24px; border-radius: 16px; margin-top: 24px; }
        .success-cta { margin-top: 20px; display: inline-flex; width: auto; min-width: 200px; }

        .res-bottom { margin-top: auto; padding-top: 24px; text-align: center; font-size: .85rem; color: #6B7280; }
        .res-bottom a { color: #5B3EF5; font-weight: 700; text-decoration: none; }

        @media (max-width: 768px) {
          .right-panel { display: none; }
          .left-panel { padding: 32px 24px; clip-path: none; }
          .card { max-width: 480px; min-height: auto; }
        }
      `}</style>
    </div>
  );
}
