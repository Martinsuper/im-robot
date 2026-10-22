// The capture window is shared; its result belongs to the tab that opened it.
let owner: string | undefined;
export function claimCapture(tabId: string | undefined) { owner = tabId; }
export function captureBelongsTo(tabId: string | undefined, active: boolean) {
  return owner ? owner === tabId : active;
}
export function releaseCapture(tabId: string | undefined) { if (owner === tabId) owner = undefined; }
