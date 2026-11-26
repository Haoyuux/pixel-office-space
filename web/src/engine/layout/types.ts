import type { Dir } from '../iso';

export interface Placed {
  piece: string; mx: number; my: number; view: number;
  lift?: number; z?: number; zi?: number; anim?: boolean;
  /** 'floor' | 'wall' | 'glass' | 'monitor:<pid>:<role>' | 'whiteboard:<pid>' | 'shelf:<pid>' | 'corkboard' | 'lamp' */
  tag?: string;
  room?: string;
}
export type Pose = 'sit' | 'stand' | 'drink';
export interface Spot {
  id: string; mx: number; my: number; pose: Pose; facing: Dir; capacity: 1;
  tags: string[]; room: string; pair?: string;
}
export interface Segment { x0: number; y0: number; x1: number; y1: number; kind: 'solid' | 'glass' }
export interface RoomRect {
  id: string; kind: 'project' | 'lounge' | 'cafeteria' | 'hall';
  x0: number; y0: number; x1: number; y1: number;
  side?: 'left' | 'right';
  door?: { x: number; y0: number; y1: number };
}
export interface Light {
  mx: number; my: number; lift: number; r: number; color: number; a: number;
  pool: boolean; halo: boolean; when?: 'always' | 'working'; tag?: string;
}
export interface Nameplate { projectId: string; mx: number; my: number; lift: number }
export interface Seat { seat: Spot; desk: { mx: number; my: number }; review: Spot }
export interface BuildingLayout {
  rooms: RoomRect[];
  pieces: Placed[];
  spots: Spot[];
  walls: Segment[];
  lights: Light[];
  seats: Record<string, Seat>;       // key `${projectId}:${role}`
  nameplates: Nameplate[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
  hallEnd: { mx: number; my: number };
}
