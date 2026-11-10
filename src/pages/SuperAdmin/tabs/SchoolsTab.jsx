import { fmtDate, sPill, getStatusRefined } from '../superAdminUtils';
import Select from '../../../components/Common/Select';
import { SchoolIcon } from '../../../components/CommonIcons';

export default function SchoolsTab({
  filteredSchools, totalSchools, activeCount, expiredCount,
  showFilter, setShowFilter,
  filterStatus, setFilterStatus,
  searchQuery,
  schools,
  settings,
  isSchoolActive,
  expiredSchools,
  handleBulkActivate, handleBulkDeactivate,
  setActivateModal, setActivationNote, setActivateSuccess,
  handleDeactivate,
  handleRowDeleteSchool,
  setFeaturesModal,
  handleOpenStaffModal,
  onNEMISExport,          // ← new: opens NEMIS export modal for a school
  handleLoginAs,          // Added handleLoginAs
  onSelectSchool,         // New: drill down into school details
  onUpdatePlan,           // New: change school plan (Production, Demo, Sandbox)
  onOpenLimitsModal,      // New: set student & staff capacity limits
  onOpenRegisterSchool,   // New: opens the Register School modal
}) {
  return (
    <div className="tv">
      <div className="panel">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
          <div className="panel-lbl" style={{ margin:0, fontSize: '0.8rem' }}>
            ALL SCHOOLS ({filteredSchools.length}/{totalSchools})
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button className="act-btn g" onClick={onOpenRegisterSchool}>+ Register School</button>
            <button className="act-btn g" onClick={handleBulkActivate}>Activate All</button>
            <button className="act-btn r" onClick={handleBulkDeactivate}>Deactivate All</button>
            <button className={`act-btn${showFilter ? ' active' : ''}`} onClick={() => setShowFilter(f => !f)}>
              {showFilter ? 'Close' : 'Filter'}
            </button>
          </div>
        </div>

        {showFilter && (
          <div className="filter-bar" style={{ marginBottom:12 }}>
            <span>Status:</span>
            {['all', 'active', 'expired', 'deactivated'].map(s => (
              <button key={s} className={`fbtn${filterStatus === s ? ' on' : ''}`} onClick={() => setFilterStatus(s)}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
                {s !== 'all' && (
                  <span style={{ marginLeft:4, opacity:.7 }}>
                    ({s === 'active' ? activeCount : s === 'expired' ? expiredCount
                      : schools.filter(x => !['Active','Suspended'].includes(x.school_profiles?.[0]?.subscription_status)).length})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {filteredSchools.length === 0 ? (
          <div className="empty">
            <div className="empty-ico"><SchoolIcon size={48} /></div>
            {searchQuery ? 'No schools match your search.' : 'No schools registered yet.'}
          </div>
        ) : (
          <div className="tbl-w">
            <table className="data-table">
              <thead>
                <tr>
                   <th className="col-school">School</th>
                   <th className="col-modules">Modules</th>
                   <th className="col-students">Students</th>
                   <th className="col-staff">Staff Seats</th>
                   <th className="col-loc">Location</th>
                   <th className="col-joined">Joined</th>
                   <th className="col-status">Status</th>
                   <th className="col-sub">Features</th>
                   <th className="col-act" style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredSchools.map(s => {
                  const isActive = isSchoolActive(s);
                  const pList = Array.isArray(s.school_profiles) ? s.school_profiles : [];
                  const p = pList.find(prof => {
                    const now = new Date();
                    const pExp = prof.subscription_expiry ? new Date(prof.subscription_expiry) : null;
                    const isExp = pExp && !isNaN(pExp.getTime()) && pExp > now;
                    return prof.subscription_status === 'Active' || isExp;
                  }) || pList[0] || {};

                  let cSubs = p.custom_subjects || {};
                  if (typeof cSubs === 'string') {
                    try { cSubs = JSON.parse(cSubs); } catch(e) { cSubs = {}; }
                  }
                  const studentLimit = cSubs.__limits?.students || p.student_limit || 10000;
                  const staffLimit = cSubs.__limits?.staff || p.staff_limit || 5;
                  const rawPlan = s.plan || (s.name?.toLowerCase().includes('demo') ? 'Demo' : 'Production');
                  const currentPlan = ['Production', 'Demo', 'Sandbox'].includes(rawPlan) 
                    ? rawPlan 
                    : (rawPlan.toLowerCase().includes('demo') ? 'Demo' : (rawPlan.toLowerCase().includes('sandbox') ? 'Sandbox' : 'Production'));

                  return (
                    <tr key={s.id}>
                      <td data-label="School" className="col-school">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div 
                            className="td-b" 
                            style={{ cursor: 'pointer', color: '#6366f1', textDecoration: 'underline', fontWeight: 600 }}
                            onClick={() => onSelectSchool(s)}
                          >
                            {s.name}
                          </div>
                          <div style={{ width: 110 }}>
                            <Select
                              value={currentPlan}
                              onChange={(val) => onUpdatePlan?.(s.id, val.target ? val.target.value : val)}
                              options={[
                                { value: 'Production', label: 'Production' },
                                { value: 'Demo', label: 'Demo' },
                                { value: 'Sandbox', label: 'Sandbox' }
                              ]}
                              className={`plan-select-badge plan-${currentPlan.toLowerCase()}`}
                            />
                          </div>
                        </div>
                        {s.phone && <div className="td-sub" style={{ marginTop: 2 }}>{s.phone}</div>}
                      </td>

                      <td data-label="Modules" className="col-modules">
                        <span className="p-pill">{s.features_count || 0} / {s.features_total || 14}</span>
                      </td>

                      <td data-label="Students" className="col-students">
                        <div className="td-m" style={{ color: (s._studentCount >= studentLimit) ? '#ef4444' : 'var(--txt)', textAlign: 'center' }}>
                          {s._studentCount || 0} / {studentLimit}
                        </div>
                      </td>

                      <td data-label="Staff Seats" className="col-staff">
                        <div style={{ display:'flex', alignItems:'center', gap:6, justifyContent: 'center' }}>
                          <div className="td-m" style={{ color: (s._staffCount >= staffLimit) ? '#ef4444' : 'var(--txt)' }}>
                            {s._staffCount || 0} / {staffLimit}
                          </div>
                          <button className="mini-btn" onClick={() => handleOpenStaffModal(s.id, s.name)}>Details</button>
                        </div>
                      </td>

                      <td data-label="Location" className="col-loc">{s.location || p.location || 'Kenya'}</td>

                      <td data-label="Joined" className="col-joined">{fmtDate(p.created_at || s.created_at)}</td>

                      <td data-label="Status" className="col-status">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                          <span className={sPill(getStatusRefined(p, isActive))}>
                            {getStatusRefined(p, isActive)}
                          </span>
                          {String(p.license_type || '').toLowerCase() === 'perpetual' ? (
                            <span style={{ fontSize: '0.68rem', color: 'var(--muted)', fontWeight: 500 }}>Lifetime licence</span>
                          ) : p.subscription_expiry && (
                            <span style={{ fontSize: '0.68rem', color: 'var(--muted)', fontWeight: 500 }}>
                              Exp: {fmtDate(p.subscription_expiry)}
                            </span>
                          )}
                          {p.license_support_until && String(p.license_type || '').toLowerCase() === 'perpetual' && (
                            <span style={{ fontSize: '0.64rem', color: 'var(--muted)' }}>Support to: {fmtDate(p.license_support_until)}</span>
                          )}
                        </div>
                      </td>

                      <td data-label="Features" className="col-sub">
                        <button className="row-btn" onClick={() => setFeaturesModal({ id:s.id, name:s.name })}>
                          Manage Features
                        </button>
                      </td>

                      <td data-label="Action" className="col-act" style={{ textAlign: 'right' }}>
                        <div className="act-group" style={{ justifyContent: 'flex-end' }}>
                          <button className="act-btn" onClick={() => onOpenLimitsModal?.(s)} title="Set student & staff capacity limits">Limits</button>
                          {isActive ? (
                            <button className="act-btn" onClick={() => handleDeactivate(s.id, s.name)}>Deactivate</button>
                          ) : (
                            <button className="act-btn g" onClick={() => { setActivateModal(s); setActivationNote(''); setActivateSuccess(false); }}>Activate</button>
                          )}
                          <button className="act-btn r" onClick={() => handleRowDeleteSchool(s.id, s.name)}>Terminate</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}