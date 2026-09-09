import { Suspense, lazy, useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import Loader from '../../components/Common/Loader';
import FeatureGate from '../../components/FeatureGate';
import { isFeatureEnabled } from '../../data/coreStore';;
import { BookIcon, UsersIcon, TeacherIcon, DashboardIcon, RocketIcon } from '../../components/CommonIcons';

const AssessmentTab = lazy(() => import('./AssessmentTab'));

export default function AcademicCenter({ currentUser, currentPeriodId }) {
  const [activeSubTab, setActiveSubTab] = useState('assessment');
  const [hasAccess, setHasAccess] = useState(null);

  useEffect(() => {
    isFeatureEnabled('grading').then(setHasAccess);
  }, []);

  if (hasAccess === null) return <Loader />;
  if (hasAccess === false) return <FeatureGate featureName="Grading" />;

  return (
    <div className="academic-center-page animate-in">
      <Helmet>
        <title>Academic Center | Termly</title>
        <meta name="description" content="Manage school assessments, class streams, and teacher assignments." />
      </Helmet>

      <div className="page-header" style={{ marginBottom: 0, paddingBottom: 0 }}>
        <div style={{ padding: '0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--text)' }}>Academic Center</h1>
            <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>Unified management for teaching and learning</p>
          </div>
        </div>
      </div>

      <div className="academic-content" style={{ padding: '24px' }}>
        <Suspense fallback={<Loader />}>
          {activeSubTab === 'assessment' && (
            <AssessmentTab currentUser={currentUser} currentPeriodId={currentPeriodId} />
          )}
        </Suspense>
      </div>

      <style>{`
        .academic-center-page {
          min-height: 100vh;
          background: var(--bg);
        }
        .tab-nav button {
          border-radius: 8px;
          padding: 8px 16px;
          font-weight: 700;
          font-size: 0.85rem;
          display: flex;
          align-items: center;
          gap: 8px;
        }
      `}</style>
    </div>
  );
}
