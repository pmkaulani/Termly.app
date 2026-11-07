import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PortalLogin from './PortalLogin';
import PortalDashboard from './PortalDashboard';
import { verifyPortalSession, logoutPortalSession } from '../../data/authStore';
import Loader from '../../components/Common/Loader';

export default function PortalManager() {
  const [portalUser, setPortalUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    async function checkSession() {
      const token = localStorage.getItem('Termly_Portal_Token');
      if (!token) {
        setPortalUser(null);
        setCheckingAuth(false);
        return;
      }

      try {
        const result = await verifyPortalSession(token);
        if (result && result.valid && result.role === 'parent') {
          // Hydrate identity verified by server
          setPortalUser({
            token,
            id: result.id,
            name: result.name,
            class: result.class,
            stream: result.stream,
            adm_no: result.adm_no,
            school_id: result.school_id,
            parent_phone: result.parent_phone,
            linkedChildren: result.linkedChildren || []
          });
        } else {
          console.warn('[PORTAL] Session verification failed:', result?.error);
          handleLogout();
        }
      } catch (err) {
        console.error('[PORTAL] Session verification error:', err);
        handleLogout();
      } finally {
        setCheckingAuth(false);
      }
    }

    checkSession();
  }, []);

  const handleLogin = (data) => {
    if (data.token) {
      localStorage.setItem('Termly_Portal_Token', data.token);
    }
    setPortalUser(data);
    // Cached presentation object only — never used as route authorization
    localStorage.setItem('Termly_portal_user', JSON.stringify(data));
  };

  const handleLogout = () => {
    const token = localStorage.getItem('Termly_Portal_Token');
    if (token) {
      logoutPortalSession(token).catch(console.warn);
    }
    setPortalUser(null);
    localStorage.removeItem('Termly_portal_user');
    localStorage.removeItem('Termly_portal_school_id');
    localStorage.removeItem('Termly_Portal_Token');
  };

  if (checkingAuth) {
    return <Loader fullPage={true} text="Verifying portal session..." />;
  }

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <Routes>
        <Route 
          path="/login" 
          element={!portalUser ? <PortalLogin onLogin={handleLogin} /> : <Navigate to="/portal/dashboard" replace />} 
        />
        <Route 
          path="/dashboard" 
          element={portalUser ? <PortalDashboard user={portalUser} onLogout={handleLogout} /> : <Navigate to="/portal/login" replace />} 
        />
        <Route path="*" element={<Navigate to={portalUser ? "/portal/dashboard" : "/portal/login"} replace />} />
      </Routes>
    </div>
  );
}
