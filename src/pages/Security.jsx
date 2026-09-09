import { useState, useEffect } from 'react';
import { getUsers, addUser, deleteUser } from '../data/authStore';
import { getSchoolProfile, getPlatformSettings } from '../data/coreStore';
import { DiamondIcon, UsersIcon, EyeIcon, EyeOffIcon } from '../components/CommonIcons';
import Select from '../components/Common/Select';
import { Helmet } from 'react-helmet-async';
import { useDialog } from '../contexts/DialogContext';

export default function Security({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [profile, setProfile] = useState({});
  const [settings, setSettings] = useState({});
  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState('');
  const { alert, confirm } = useDialog();

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const [uData, pData, sData] = await Promise.all([
          getUsers(), 
          getSchoolProfile(),
          getPlatformSettings()
        ]);
        setUsers(uData || []);
        setProfile(pData || {});
        setSettings(sData || {});
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    init();

    const loadProfile = async () => {
      try { setProfile(await getSchoolProfile()); } catch(err) {} 
    };
    window.addEventListener('schoolProfileChanged', loadProfile);
    return () => window.removeEventListener('schoolProfileChanged', loadProfile);
  }, []);

  const refresh = async () => {
    try { setUsers(await getUsers()); } catch (err) { console.error(err); }
  };

  const planName = profile?.subscriptionPlan || 'Starter Plan';
  const pricing = settings?.pricing || {};
  const activePlanKey = Object.keys(pricing).find(k => k.toLowerCase() === planName.toLowerCase());

  const fallbackPlans = {
    "Sandbox": { price: 0, limit: 150, seats: 10 },
    "Starter Plan": { price: 5999, limit: 150, seats: 5 },
    "Champe": { price: 50000, limit: 5000, seats: 20 }
  };

  let cSubs = profile?.custom_subjects || profile?.customSubjects || {};
  if (typeof cSubs === 'string') {
    try { cSubs = JSON.parse(cSubs); } catch(e) { cSubs = {}; }
  }
  const customStaffLimit = cSubs.__limits?.staff || profile?.staffLimit || profile?.staff_limit;
  
  let seatLimit;
  if (customStaffLimit) {
    seatLimit = customStaffLimit;
  } else if (activePlanKey && pricing[activePlanKey]) {
    seatLimit = pricing[activePlanKey].seats || pricing[activePlanKey].admins || pricing[activePlanKey].seat_limit || 10;
  } else if (fallbackPlans[planName]) {
    seatLimit = fallbackPlans[planName].seats || 10;
  } else {
    seatLimit = 10;
  }

  const actualStaffCount = users.length;
  const isAtLimit = actualStaffCount >= seatLimit;

  const handleDelete = async (id) => {
    try {
      if (await confirm({ title: 'Delete User', message: 'Are you sure you want to delete this user?', variant: 'danger' })) {
        setLoading(true);
        await deleteUser(id);
        await refresh();
        setLoading(false);
      }
    } catch (err) {
      alert({ title: 'Error', message: err.message, variant: 'danger' });
      setLoading(false);
    }
  };

  const handleAdd = async (user) => {
    try {
      setLoading(true);
      await addUser(user);
      await refresh();
      setShowModal(false);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="animate-in">
      <Helmet>
        <title>Security & Access Control | Termly — System Safety</title>
        <meta name="description" content="Manage staff roles, user permissions, and school security settings. Monitor admin access and platform seats." />
      </Helmet>
      <div className="page-header">
        <div className="page-header-actions">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <h2>Security & Access</h2>
              <p>Manage administrator roles and access control</p>
            </div>
            {loading && <span className="text-muted" style={{ fontSize: '0.85rem' }}>Loading...</span>}
          </div>
          <div>
              <button 
                className="btn btn-primary" 
                onClick={() => setShowModal(true)}
                style={{ opacity: isAtLimit ? 0.6 : 1, cursor: isAtLimit ? 'not-allowed' : 'pointer'}}
                disabled={isAtLimit}
                title={isAtLimit ? 'Limit reached' : 'Add new user'}
              >
                + Add Staff Member
              </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24, alignItems: 'start' }}>
        
        {/* Users Table */}
        <div className="card">
          <div className="card-header">
            <h3><UsersIcon size={18} /> Access Management</h3>
            <span className="badge badge-primary">{actualStaffCount} / {seatLimit} staff seats</span>
          </div>
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isSelf = currentUser && currentUser.id === u.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.name}</strong>
                        {isSelf && <span className="text-muted" style={{ marginLeft: 6, fontSize: '0.75rem' }}>(You)</span>}
                      </td>
                      <td>{u.email}</td>
                      <td>
                        <span className="badge badge-secondary">{u.role}</span>
                      </td>
                      <td>
                        {isSelf ? (
                          <span className="text-muted" style={{ fontSize: '0.8rem' }}>Current User</span>
                        ) : (
                          <button 
                            className="btn btn-sm btn-outline-danger"
                            onClick={() => handleDelete(u.id)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && !loading && (
                  <tr>
                    <td colSpan="4" className="text-center text-muted" style={{ padding: 24 }}>
                      No staff members added yet. Click "+ Add Staff Member" to grant access.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {showModal && (
        <AddUserModal 
          onClose={() => { setShowModal(false); setError(''); }}
          onSave={handleAdd}
          error={error}
          isAtLimit={isAtLimit}
        />
      )}
    </div>
  );
}

function AddUserModal({ onClose, onSave, error, isAtLimit }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Teacher');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name || !email) return;
    setSubmitting(true);
    await onSave({ name, email, role, password });
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
        <div className="modal-header">
          <h3>Add New User</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        
        {error && (
          <div className="alert alert-danger" style={{ margin: '16px 20px 0 20px' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label>FULL NAME</label>
              <input 
                type="text" 
                className="form-control" 
                placeholder="e.g. Jane Doe"
                value={name} 
                onChange={e => setName(e.target.value)} 
                required 
              />
            </div>

            <div className="form-group">
              <label>EMAIL ADDRESS</label>
              <input 
                type="email" 
                className="form-control" 
                placeholder="jane@school.com"
                value={email} 
                onChange={e => setEmail(e.target.value)} 
                required 
              />
            </div>

            <div className="form-group">
              <label>ROLE</label>
              <Select
                value={role}
                onChange={e => setRole(e.target.value)}
                options={[
                  { value: 'Teacher', label: 'Teacher (Grading, Attendance, Students)' },
                  { value: 'Bursar', label: 'Bursar (Fees, Payments, Financial Reports)' },
                  { value: 'Librarian', label: 'Librarian (Book Inventory & Issuance)' },
                  { value: 'Admin', label: 'Administrator (Full Access)' }
                ]}
              />
            </div>

            <div className="form-group">
              <label>TEMPORARY PASSWORD</label>
              <div style={{ position: 'relative' }}>
                <input 
                  type={showPassword ? "text" : "password"}
                  className="form-control" 
                  placeholder="Leave blank to auto-generate"
                  value={password} 
                  onChange={e => setPassword(e.target.value)} 
                  style={{ paddingRight: 40 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)'
                  }}
                >
                  {showPassword ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                </button>
              </div>
              <small className="text-muted" style={{ display: 'block', marginTop: 4, fontSize: '0.75rem' }}>
                Must be at least 6 characters. If left blank, a secure temporary password will be generated.
              </small>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting || isAtLimit}>
              {submitting ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
