import { useEffect, useMemo } from 'react';
import { OfficeCanvas } from './engine/OfficeCanvas';
import { demoCount, demoProjects } from './demo';
import { useOffice } from './state/store';
import { startOffice } from './state/socket';

export function App() {
  const demo = demoCount();
  return demo === null ? <LiveOffice /> : <DemoOffice n={demo} />;
}

/** `?demo=N`: fake projects, idle office life only (no server). */
function DemoOffice({ n }: { n: number }) {
  const projects = useMemo(() => demoProjects(n), [n]);
  return <OfficeCanvas projects={projects} />;
}

/** Projects and tickets from the server: snapshot + events over the socket, driven by the ticket director. */
function LiveOffice() {
  useEffect(() => startOffice(), []);
  const synced = useOffice(s => s.synced);
  const map = useOffice(s => s.projects);
  const projects = useMemo(() => Object.values(map).sort((a, b) => a.slot - b.slot), [map]);
  const select = useOffice(s => s.select);
  const onRoomClick = (id: string | null) => select(id && id === useOffice.getState().selectedProjectId ? null : id);
  return synced ? <OfficeCanvas projects={projects} live onRoomClick={onRoomClick} /> : null;
}
