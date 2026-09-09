import React, { useState, useEffect } from 'react';
import { getSchoolProfile, saveSchoolProfile } from '../../data/coreStore';
import { getTeachers } from '../../data/staffStore';
import { getSubjectAssignments } from '../../data/academicsStore';;
import { getSubjectsForGrade } from '../../data/seedData';
import { TeacherIcon, BookIcon, CheckIcon, CrossIcon } from '../../components/CommonIcons';
import Select from '../../components/Common/Select';
import { useDialog } from '../../contexts/DialogContext';

export default function TeacherAssignmentManager() {
  const { alert } = useDialog();
  const [profile, setProfile] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedClass, setSelectedClass] = useState('Grade 1');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [p, t, a] = await Promise.all([getSchoolProfile(), getTeachers(), getSubjectAssignments()]);
      setProfile(p);
      setTeachers(t.filter(teacher => teacher.status === 'Active'));
      setAssignments(a);
      if (p.activeClasses?.length > 0 && !p.activeClasses.includes(selectedClass)) {
        setSelectedClass(p.activeClasses[0]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAssign = async (subject, stream, teacherId) => {
    const updated = {
      ...assignments,
      [selectedClass]: {
        ...(assignments[selectedClass] || {}),
        [stream]: {
          ...(assignments[selectedClass]?.[stream] || {}),
          [subject]: teacherId
        }
      }
    };

    try {
      await saveSchoolProfile({ subjectAssignments: updated });
      setAssignments(updated);
    } catch (err) {
      alert({ title: 'Update Error', message: err.message, variant: 'danger' });
    }
  };

  if (loading) return <div className="flex-center" style={{ minHeight: 300 }}><div className="spinner"></div></div>;

  const classStreams = profile?.streamsPerClass?.[selectedClass] || ['Main'];
  const classSubjects = getSubjectsForGrade(selectedClass, profile);

  return (
    <div className="teacher-assignment-manager animate-in">
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3><TeacherIcon size={18} /> Teacher-Subject Assignments</h3>
          <Select 
            value={selectedClass} 
            onChange={e => setSelectedClass(e.target.value)}
            options={(profile?.activeClasses || []).map(c => ({ id: c, label: c }))}
            style={{ minWidth: 160 }}
          />
        </div>
        <div className="card-body" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table responsive-table">
            <thead>
              <tr>
                <th>Subject</th>
                {classStreams.map(s => <th key={s}>{s} Stream</th>)}
              </tr>
            </thead>
            <tbody>
              {classSubjects.map(sub => (
                <tr key={sub}>
                  <td style={{ fontWeight: 600 }}>{sub}</td>
                  {classStreams.map(stream => {
                    const currentId = assignments[selectedClass]?.[stream]?.[sub] || '';
                    return (
                      <td key={stream}>
                        <Select 
                          value={currentId} 
                          onChange={e => handleAssign(sub, stream, e.target.value)}
                          options={[
                            { id: '', label: 'Unassigned' },
                            ...teachers.map(t => ({ id: t.id, label: t.name }))
                          ]}
                          variant="minimal"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
