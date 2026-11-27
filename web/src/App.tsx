import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoleId } from '@office/shared';
import { OfficeCanvas } from './engine/OfficeCanvas';
import type { OfficeScene } from './engine/render/scene';
import { demoCount, demoProjects } from './demo';
import { useOffice } from './state/store';
import { startOffice } from './state/socket';
import { Toolbar } from './ui/Toolbar';
import { AddProjectDialog } from './ui/AddProjectDialog';
import { Drawer, DRAWER_WIDTH } from './ui/Drawer';
import { CorkTooltip } from './ui/CorkTooltip';
import { useRevealSelected } from './ui/useRevealSelected';
import { startNotifications } from './ui/notifications';
import { SummaryPanel, checkDailySummary } from './ui/Summary';
import './ui/theme.css';

export function App() {
  const demo = demoCount();
  return demo === null ? <LiveOffice /> : <DemoOffice n={demo} />;
}

/** Fit Building: `camera.fit(scene.buildingBounds())`, leaving the drawer's strip free when it is open. */
const fitBuilding = (scene: OfficeScene | null, drawer: boolean) => scene?.camera?.fit(scene.buildingBounds(), drawer ? DRAWER_WIDTH : 0);

/** `?demo=N`: fake projects, idle office life only (no server). */
function DemoOffice({ n }: { n: number }) {
  const projects = useMemo(() => demoProjects(n), [n]);
  const scene = useRef<OfficeScene | null>(null);
  return (
    <div className="po-app">
      <OfficeCanvas projects={projects} onReady={s => { scene.current = s; }} />
      <Toolbar onFit={() => fitBuilding(scene.current, false)} />
    </div>
  );
}

/** Projects and tickets from the server: snapshot + events over the socket, driven by the ticket director. */
function LiveOffice() {
  useEffect(() => startOffice(), []);
  useEffect(() => startNotifications(), []);
  // dev-only hook so tools/e2e.mjs can select a room / read the feed without pixel-hunting
  if (import.meta.env.DEV) (window as unknown as { __store?: typeof useOffice }).__store = useOffice;
  const synced = useOffice(s => s.synced);
  const map = useOffice(s => s.projects);
  const selected = useOffice(s => s.selectedProjectId);
  const projects = useMemo(() => Object.values(map).sort((a, b) => a.slot - b.slot), [map]);
  const scene = useRef<OfficeScene | null>(null);
  const [adding, setAdding] = useState(false);
  const [cork, setCork] = useState<{ x: number; y: number } | null>(null);
  /** The summary board: open with this `since` (undefined = the panel's default range). */
  const [summary, setSummary] = useState<{ since?: string } | null>(null);
  // the day's first visit: the summary opens by itself when anything happened since the last one
  useEffect(() => { void checkDailySummary(since => setSummary({ since })); }, []);
  const openSummary = useCallback(() => { setCork(null); setSummary({}); }, []);

  const onRoomClick = useCallback((id: string | null) => {
    const s = useOffice.getState();
    if (id && id === s.selectedProjectId) { s.select(null); return; }
    s.setRoleFilter('all');
    s.select(id);
  }, []);
  const onBotClick = useCallback((projectId: string, role: RoleId) => {
    const s = useOffice.getState();
    s.setRoleFilter(role);
    s.select(projectId);
  }, []);

  // keep the selected room visible beside the drawer
  useRevealSelected(scene, selected, !!selected && !!map[selected], DRAWER_WIDTH);

  if (!synced) return null;
  const drawer = !!selected && !!map[selected];
  return (
    <div className="po-app">
      <OfficeCanvas projects={projects} live onRoomClick={onRoomClick} onBotClick={onBotClick} onCorkHover={setCork} onCorkClick={openSummary}
        onReady={s => { scene.current = s; }} />
      <Toolbar onAdd={() => setAdding(true)} onFit={() => fitBuilding(scene.current, drawer)} onSummary={openSummary} notify />
      {drawer && <Drawer key={selected} projectId={selected!} />}
      {cork && <CorkTooltip x={cork.x} y={cork.y} />}
      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
      {summary && <SummaryPanel since={summary.since} onClose={() => setSummary(null)} />}
    </div>
  );
}
