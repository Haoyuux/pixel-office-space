import { useEffect, type MutableRefObject } from 'react';
import type { OfficeScene } from '../engine/render/scene';

/**
 * Pans the camera so the selected room is visible beside the drawer. Runs when the selection changes and again when
 * the selected project first reaches the store (Add Project selects it before `project.added` arrives).
 */
export function useRevealSelected(scene: MutableRefObject<Pick<OfficeScene, 'camera' | 'roomBounds'> | null>, selected: string | null, present: boolean, insetRight: number): void {
  useEffect(() => {
    const s = scene.current, box = selected && present ? s?.roomBounds(selected) : null;
    if (s?.camera && box) s.camera.reveal(box, insetRight);
    // `scene` is a ref: reading .current at run time is the point, it is not a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, present, insetRight]);
}
