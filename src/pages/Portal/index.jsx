import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PortalLogin from './PortalLogin';
import PortalDashboard from './PortalDashboard';
import { supabase } from '../../lib/supabase';

export default function PortalManager() {
  const [portalUser, setPortalUser] = useState(() => {
    const saved = localStorage.getItem('Termly_portal_user');
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    if (portalUser?.id && portalUser?.school_id) {
      // Lightweight validation: check if the student profile still exists/is accessible
      supabase.rpc('portal_get_student_profile', { 
        p_student_id: portalUser.id, 
        p_school_id: portalUser.school_id 
      }).then(({ data, error }) => {
        if (error || !data || data.length === 0) {
          console.warn("Portal session invalid or expired");
          handleLogout();
        }
      });
    }
  }, [portalUser?.id, portalUser?.school_id]);

  const handleLogin = (data) => {
    setPortalUser(data);
    localStorage.setItem('Termly_portal_user', JSON.stringify(data));
    // Store session token for IDOR-protected RPC calls
    if (data.token) {
      localStorage.setItem('Termly_Portal_Token', data.token);
    }
  };

  const handleLogout = () => {
    setPortalUser(null);
    localStorage.removeItem('Termly_portal_user');
    localStorage.removeItem('Termly_portal_school_id');
    localStorage.removeItem('Termly_Portal_Token');
  };

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
