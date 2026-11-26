import type { Dir } from '../iso';

export interface Placed {
  piece: string; mx: number; my: number; view: number;
  lift?: number; z?: number; zi?: number; anim?: boolean;
  /** 'floor' | 'wall' | 'glass' | 'monitor:<pid>:<role>' | 'whiteboard:<pid>' | 'shelf:<pid>' | 'corkboard' | 'lamp' */
  tag?: string;
  room?: string;
  /** 'neon' = a NEON OFFICE prop (`piece` is its folder name, e.g. 'arcade_cabinet'); default = Isometric_Pixel_Props. */
  pack?: 'neon';
  /** Neon props: `<finish>_<neon>`, e.g. 'graphite_magenta'. */
  variant?: string;
}
/** A code-drawn rug on the floor (world metres), under a seating group or a zone. */
export interface Rug {
  id: string; room: string;
  x0: number; y0: number; x1: number; y1: number;
  color: number; border: number; accent: number;
  pattern: 'stripes' | 'diamonds' | 'checks' | 'plain';
}
export type Pose = 'sit' | 'stand' | 'drink';
export interface Spot {
  id: string; mx: number; my: number; pose: Pose; facing: Dir; capacity: 1;
  tags: string[]; room: string; pair?: string;
  /** Sit spots: hip height on the seat, metres (default SEAT_LIFT, an office/dining chair). */
  seatHeight?: number;
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
  rugs: Rug[];
  seats: Record<string, Seat>;       // key `${projectId}:${role}`
  nameplates: Nameplate[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
  hallEnd: { mx: number; my: number };
}
