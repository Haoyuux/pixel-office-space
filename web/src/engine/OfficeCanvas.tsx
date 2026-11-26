import { useEffect, useRef } from 'react';
import { Application } from 'pixi.js';
import type { Project } from '@office/shared';
import { buildLayout } from './layout/building';
import { loadPieceMeta } from './assets';
import { OfficeScene } from './render/scene';
import { Camera } from './render/camera';

declare global {
  interface Window { __office?: OfficeScene }
}

/** Surface async failures as window errors (shown in #err, read by tools/shot.mjs). */
const rethrow = (e: unknown) => setTimeout(() => { throw e; });

interface Props {
  projects: Project[];
  /** Click on a project room (null = click outside any project room). Defaults to toggling the selection. */
  onRoomClick?: (projectId: string | null) => void;
  onReady?: (scene: OfficeScene) => void;
}

/** Mounts a Pixi Application with the office scene and the camera. */
export function OfficeCanvas({ projects, onRoomClick, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
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
      cleanup = () => {
        app.canvas.removeEventListener('pointermove', move);
        app.canvas.removeEventListener('pointerleave', leave);
        app.canvas.removeEventListener('pointerup', click);
        camera.destroy(); scene.destroy();
      };
      draw(projectsRef.current).catch(rethrow);
      onReady?.(scene);
    });
    return () => {
      alive = false;
      if (inited) { cleanup(); app.destroy(true, { children: true }); }
      sceneRef.current = null;
      if (window.__office && !window.__office.world.parent) delete window.__office;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function draw(list: Project[]) {
    const scene = sceneRef.current;
    if (!scene) return;
    const layout = buildLayout(list, await loadPieceMeta());
    await scene.setLayout(layout, list);
    if (!fitted.current && scene.layout === layout) { fitted.current = true; scene.camera?.fit(scene.buildingBounds()); }
  }

  useEffect(() => { draw(projects).catch(rethrow); }, [projects]);

  return <div ref={host} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
}
