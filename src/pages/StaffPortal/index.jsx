import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import StaffLogin from './StaffLogin';
import MobileGrading from './MobileGrading';
import { verifyPortalSession, logoutPortalSession } from '../../data/authStore';
import Loader from '../../components/Common/Loader';

export default function StaffPortalManager() {
  const [staffUser, setStaffUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    async function checkSession() {
      const token = localStorage.getItem('Termly_Staff_Token');
      if (!token) {
        setStaffUser(null);
        setCheckingAuth(false);
        return;
      }

      try {
        const result = await verifyPortalSession(token);
        if (result && result.valid && (result.role === 'teacher' || result.role === 'admin')) {
          setStaffUser({
            token,
            id: result.id,
            teacher_record_id: result.teacher_record_id || result.id,
            user_id: result.user_id || result.id,
            name: result.name,
            role: 'teacher',
            school_id: result.school_id
          });
        } else {
          console.warn('[STAFF PORTAL] Session verification failed:', result?.error);
          handleLogout();
        }
      } catch (err) {
        console.error('[STAFF PORTAL] Session verification error:', err);
        handleLogout();
      } finally {
        setCheckingAuth(false);
      }
    }

    checkSession();
  }, []);

  const handleLogin = (data) => {
    if (data.token) {
      localStorage.setItem('Termly_Staff_Token', data.token);
    }
    setStaffUser(data);
    localStorage.setItem('Termly_staff_user', JSON.stringify(data));
  };

  const handleLogout = () => {
    const token = localStorage.getItem('Termly_Staff_Token');
    if (token) {
      logoutPortalSession(token).catch(console.warn);
    }
    setStaffUser(null);
    localStorage.removeItem('Termly_staff_user');
    localStorage.removeItem('Termly_Staff_Token');
  };

  if (checkingAuth) {
    return <Loader fullPage={true} text="Verifying staff portal session..." />;
  }

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <Routes>
        <Route 
          path="/login" 
          element={!staffUser ? <StaffLogin onLogin={handleLogin} /> : <Navigate to="/staff/grading" replace />} 
        />
        <Route 
          path="/grading" 
          element={staffUser ? <MobileGrading user={staffUser} onLogout={handleLogout} /> : <Navigate to="/staff/login" replace />} 
        />
        <Route path="*" element={<Navigate to={staffUser ? "/staff/grading" : "/staff/login"} replace />} />
      </Routes>
    </div>
  );
}
