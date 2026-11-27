import { useEffect, useRef } from 'react';
import { Application } from 'pixi.js';
import type { Project } from '@office/shared';
import { buildLayout } from './layout/building';
import { loadPieceMeta } from './assets';
import { OfficeScene } from './render/scene';
import { Camera } from './render/camera';
import { Population } from './bots/population';
import { Director } from './bots/director';
import { isTerminal, type RoleId } from '@office/shared';
import { doneCount, useOffice, type OfficeState } from '../state/store';
import { roomBadge, DONE_BADGE_MS } from '../state/badges';
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
  /** Click on a bot (wins over the room under it). */
  onBotClick?: (projectId: string, role: RoleId) => void;
  /** Pointer over the cafeteria cork board (client coords), or null when it leaves. */
  onCorkHover?: (at: { x: number; y: number } | null) => void;
  /** Click on the cafeteria cork board (the summary board). */
  onCorkClick?: () => void;
  onReady?: (scene: OfficeScene) => void;
}

/** Mounts a Pixi Application with the office scene and the camera. */
export function OfficeCanvas({ projects, live = false, onRoomClick, onBotClick, onCorkHover, onCorkClick, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const botsRef = useRef<Population | null>(null);
  const fitted = useRef(false);
  const clickRef = useRef(onRoomClick);
  clickRef.current = onRoomClick;
  const botClickRef = useRef(onBotClick);
  botClickRef.current = onBotClick;
  const corkRef = useRef(onCorkHover);
  corkRef.current = onCorkHover;
  const corkClickRef = useRef(onCorkClick);
  corkClickRef.current = onCorkClick;
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
      let onCork = false;
      const cork = (at: { x: number; y: number } | null) => { if (at || onCork) corkRef.current?.(at); onCork = !!at; };
      const move = (e: PointerEvent) => {
        const p = local(e), id = scene.roomAt(...p);
        scene.setHover(isProject(id) ? id : null);
        cork(scene.corkboardAt(...p) ? { x: e.clientX, y: e.clientY } : null);
      };
      const leave = () => { scene.setHover(null); cork(null); };
      /** The bot whose sprite is under a canvas point (Pixi hit test; bot views are interactive). */
      const botAt = (x: number, y: number) => {
        for (let c = app.renderer.events.rootBoundary.hitTest(x, y); c; c = c.parent!) {
          for (const b of bots.bots.values()) if (b.view === c) return b;
        }
        return null;
      };
      const click = (e: PointerEvent) => {
        if (camera.dragged || e.button !== 0) return;
        const bot = botClickRef.current ? botAt(...local(e)) : null;
        if (bot && isProject(bot.projectId)) { botClickRef.current!(bot.projectId, bot.role); return; }
        if (corkClickRef.current && scene.corkboardAt(...local(e))) { corkClickRef.current(); return; }
        const raw = scene.roomAt(...local(e)), id = isProject(raw) ? raw : null;
        if (clickRef.current) clickRef.current(id);
        else scene.setSelected(id);
      };
      app.canvas.addEventListener('pointermove', move);
      app.canvas.addEventListener('pointerleave', leave);
      app.canvas.addEventListener('pointerup', click);
      const stopLive = live ? startDirector(scene, bots) : () => {};
      scene.setNight(useOffice.getState().night);
      const stopNight = useOffice.subscribe((s, prev) => { if (s.night !== prev.night) scene.setNight(s.night); });
      cleanup = () => {
        stopLive(); stopNight();
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
    const badges = new Map<string, string | null>();
    /** When each project last finished a ticket live (for the 5 s `✓ done` badge). */
    const doneAt = new Map<string, number>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let selected: string | null | undefined;
    const sync = (s: OfficeState, prev?: OfficeState) => {
      if (prev && s.tickets !== prev.tickets) {
        for (const t of Object.values(s.tickets)) {
          const was = prev.tickets[t.id];
          if (t.status === 'done' && was && !isTerminal(was)) {
            doneAt.set(t.projectId, performance.now());
            const timer = setTimeout(() => { timers.delete(timer); sync(useOffice.getState()); }, DONE_BADGE_MS + 50);
            timers.add(timer);
          }
        }
      }
      for (const id of Object.keys(s.projects)) {
        const n = Math.min(5, doneCount(s, id));
        if (trophies.get(id) !== n) { trophies.set(id, n); scene.setTrophies(id, n); }
        const b = roomBadge(Object.values(s.tickets), id, doneAt.get(id), performance.now());
        if (badges.get(id) !== b) { badges.set(id, b); scene.setBadge(id, b); }
      }
      if (s.selectedProjectId !== selected) { selected = s.selectedProjectId; scene.setSelected(selected); }
    };
    sync(s0);
    const unsub = useOffice.subscribe((s, prev) => { if (s.tickets !== prev.tickets || s.projects !== prev.projects || s.selectedProjectId !== prev.selectedProjectId) sync(s, prev); });
    return () => {
      off(); unsub(); director.destroy(); bots.hooks = {};
      for (const t of timers) clearTimeout(t);
      if (window.__director === director) delete window.__director;
    };
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
