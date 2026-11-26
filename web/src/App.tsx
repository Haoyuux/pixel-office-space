import { useEffect, useState } from 'react';
import type { Project } from '@office/shared';
import { OfficeCanvas } from './engine/OfficeCanvas';
import { demoCount, demoProjects } from './demo';

export function App() {
  const demo = demoCount();
  const [projects, setProjects] = useState<Project[] | null>(() => (demo === null ? null : demoProjects(demo)));

  useEffect(() => {
    if (demo !== null) return;
    fetch('/api/projects').then(r => (r.ok ? r.json() : [])).then((list: Project[]) => setProjects(list)).catch(() => setProjects([]));
  }, [demo]);

  return projects ? <OfficeCanvas projects={projects} /> : null;
}
