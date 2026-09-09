import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import StaffLogin from './StaffLogin';
import MobileGrading from './MobileGrading';
import { supabase } from '../../lib/supabase';

export default function StaffPortalManager() {
  const [staffUser, setStaffUser] = useState(() => {
    const saved = localStorage.getItem('Termly_staff_user');
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    if (staffUser?.teacher_record_id && staffUser?.school_id) {
      // Lightweight validation: check if the teacher can still fetch assignments
      supabase.rpc('portal_get_teacher_assignments', { 
        p_teacher_id: staffUser.teacher_record_id, 
        p_school_id: staffUser.school_id 
      }).then(({ error }) => {
        if (error) {
          console.warn("Staff session invalid or expired");
          handleLogout();
        }
      });
    }
  }, [staffUser?.teacher_record_id, staffUser?.school_id]);

  const handleLogin = (data) => {
    setStaffUser(data);
    localStorage.setItem('Termly_staff_user', JSON.stringify(data));
    // Store session token for IDOR-protected RPC calls
    if (data.token) {
      localStorage.setItem('Termly_Staff_Token', data.token);
    }
  };

  const handleLogout = () => {
    setStaffUser(null);
    localStorage.removeItem('Termly_staff_user');
    localStorage.removeItem('Termly_Staff_Token');
  };

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
