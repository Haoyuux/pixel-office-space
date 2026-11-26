import { useEffect, useRef } from 'react';
import { Application } from 'pixi.js';
import type { Project } from '@office/shared';
import { buildLayout } from './layout/building';
import { loadPieceMeta } from './assets';
import { OfficeScene } from './render/scene';
import { Camera } from './render/camera';
import { Population } from './bots/population';
import { Director } from './bots/director';
import { isTerminal } from '@office/shared';
import { doneCount, useOffice } from '../state/store';
import { onServerEvent } from '../state/socket';

declare global {
  interface Window { __office?: OfficeScene; __bots?: Population; __director?: Director }
}

/** Surface async failures as window errors (shown in #err, read by tools/shot.mjs). */
const rethrow = (e: unknown) => setTimeout(() => { throw e; });

interface Props {
  projects: Project[];
  /** Live mode: tickets drive the bots (ticket director fed by the store/socket); selection follows the store. */
  live?: boolean;
  /** Click on a project room (null = click outside any project room). Defaults to toggling the selection. */
  onRoomClick?: (projectId: string | null) => void;
  onReady?: (scene: OfficeScene) => void;
}

/** Mounts a Pixi Application with the office scene and the camera. */
export function OfficeCanvas({ projects, live = false, onRoomClick, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const botsRef = useRef<Population | null>(null);
  const fitted = useRef(false);
  const clickRef = useRef(onRoomClick);
  clickRef.current = onRoomClick;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    const el = host.current!;
    const app = new Application();
    let alive = true, inited = false;
    let cleanup = () => {};
    app.init({ resizeTo: el, background: 0x9fb4cc, antialias: false, autoDensity: true, resolution: 1 }).then(() => {
      inited = true;
      if (!alive) { app.destroy(true, { children: true }); return; }
      el.appendChild(app.canvas);
      const scene = new OfficeScene(app);
      const camera = new Camera(app, scene.world);
      camera.attach(app.canvas);
      scene.camera = camera;
      sceneRef.current = scene;
      window.__office = scene;
      const bots = new Population(scene, app.ticker);
      botsRef.current = bots;
      window.__bots = bots;

      const isProject = (id: string | null) => !!id && projectsRef.current.some(p => p.id === id);
      const local = (e: PointerEvent) => { const r = app.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
      const move = (e: PointerEvent) => { const id = scene.roomAt(...local(e)); scene.setHover(isProject(id) ? id : null); };
      const leave = () => scene.setHover(null);
      const click = (e: PointerEvent) => {
        if (camera.dragged || e.button !== 0) return;
        const raw = scene.roomAt(...local(e)), id = isProject(raw) ? raw : null;
        if (clickRef.current) clickRef.current(id);
        else scene.setSelected(id);
      };
      app.canvas.addEventListener('pointermove', move);
      app.canvas.addEventListener('pointerleave', leave);
      app.canvas.addEventListener('pointerup', click);
      const stopLive = live ? startDirector(scene, bots) : () => {};
      cleanup = () => {
        stopLive();
        app.canvas.removeEventListener('pointermove', move);
        app.canvas.removeEventListener('pointerleave', leave);
        app.canvas.removeEventListener('pointerup', click);
        bots.destroy(); camera.destroy(); scene.destroy();
      };
      draw(projectsRef.current).catch(rethrow);
      onReady?.(scene);
    });
    return () => {
      alive = false;
      if (inited) { cleanup(); app.destroy(true, { children: true }); }
      sceneRef.current = null;
      botsRef.current = null;
      if (window.__office && !window.__office.world.parent) delete window.__office;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Wires the ticket director: store state now, socket events from here on, trophies and selection from the store. */
  function startDirector(scene: OfficeScene, bots: Population): () => void {
    const director = new Director(scene, bots, bots.bots, { walkable: (x, y) => bots.grid?.walkable(x, y) ?? true },
      { doneCount: pid => doneCount(useOffice.getState(), pid) });
    window.__director = director;
    bots.hooks = { onAdded: (b, seat) => director.onAdded(b, seat), onRemoved: b => director.onRemoved(b) };
    const s0 = useOffice.getState();
    director.apply({ type: 'snapshot', ts: '', snapshot: { projects: Object.values(s0.projects), tickets: Object.values(s0.tickets).filter(t => !isTerminal(t)) } });
    const off = onServerEvent(e => director.apply(e));
    const trophies = new Map<string, number>();
    let selected: string | null | undefined;
    const sync = (s: ReturnType<typeof useOffice.getState>) => {
      for (const id of Object.keys(s.projects)) {
        const n = Math.min(5, doneCount(s, id));
        if (trophies.get(id) !== n) { trophies.set(id, n); scene.setTrophies(id, n); }
      }
      if (s.selectedProjectId !== selected) { selected = s.selectedProjectId; scene.setSelected(selected); }
    };
    sync(s0);
    const unsub = useOffice.subscribe((s, prev) => { if (s.tickets !== prev.tickets || s.projects !== prev.projects || s.selectedProjectId !== prev.selectedProjectId) sync(s); });
    return () => { off(); unsub(); director.destroy(); bots.hooks = {}; if (window.__director === director) delete window.__director; };
  }

  async function draw(list: Project[]) {
    const scene = sceneRef.current;
    if (!scene) return;
    const meta = await loadPieceMeta();
    const layout = buildLayout(list, meta);
    await scene.setLayout(layout, list);
    if (scene.layout === layout) await botsRef.current?.build(layout, list, meta);
    if (!fitted.current && scene.layout === layout) { fitted.current = true; scene.camera?.fit(scene.buildingBounds()); }
  }

  useEffect(() => { draw(projects).catch(rethrow); }, [projects]);

  return <div ref={host} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
}
