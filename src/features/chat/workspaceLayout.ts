export interface WorkspaceBounds { x: number; y: number; width: number; height: number }

/** Fit the expanded workspace inside the current monitor's usable logical bounds. */
export function fitWorkspace(current: WorkspaceBounds, screen: WorkspaceBounds): WorkspaceBounds {
  const width = Math.min(screen.width, Math.max(current.width, 1040));
  const height = Math.min(screen.height, Math.max(current.height, 700));
  return {
    width, height,
    x: Math.max(screen.x, Math.min(current.x, screen.x + screen.width - width)),
    y: Math.max(screen.y, Math.min(current.y, screen.y + screen.height - height)),
  };
}
