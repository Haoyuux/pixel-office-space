import type { PieceMeta } from './pieces';

/**
 * NEON OFFICE pack (assets/office/neon-office-free): one isometric view per prop, drawn at 48 px per metre, so it is
 * scaled by 128 / 48 to match the 128 ppm Isometric_Pixel_Props. The native view faces +y (layout view 0); view 6
 * (facing +x) is the same sprite mirrored. The lit (`on`) state is always used: the cabinets and pouf rims glow by day
 * too, and at night the pack's `_on_glow` layer is added on top (additive, untinted).
 */
export const NEON_DIR = '/assets/office/neon-office-free/large/iso';
export const NEON_SCALE = 128 / 48;
export const NEON_PPM = 48;

/**
 * Frame size and pivot are the manifest's `views.iso.large` values (identical for every finish / neon / state);
 * sx / sy / sz are the real-world size in metres, measured from the opaque pixels (the frames carry a glow margin).
 */
export const NEON_META: Record<string, PieceMeta> = {
  arcade_cabinet: { cat: 'neon', w: 99, h: 122, gx: 35, gy: 96, sx: 0.75, sy: 0.75, sz: 1.5, anim: 0 },
  pouf: { cat: 'neon', w: 72, h: 60, gx: 32, gy: 40, sx: 0.5, sy: 0.5, sz: 0.41, anim: 0 },
  side_table: { cat: 'neon', w: 72, h: 69, gx: 30, gy: 50, sx: 0.45, sy: 0.45, sz: 0.5, anim: 0 },
  planter_box: { cat: 'neon', w: 89, h: 78, gx: 39, gy: 55, sx: 1.0, sy: 0.6, sz: 0.55, anim: 0 },
};

/** `<prop>/<prop>_<finish>_<neon>_on[_glow].png` for a placed neon prop (`variant` = `<finish>_<neon>`). */
export const neonUrl = (prop: string, variant: string, glow = false) =>
  `${NEON_DIR}/${prop}/${prop}_${variant}_on${glow ? '_glow' : ''}.png`;
