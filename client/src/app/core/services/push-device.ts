/**
 * Which account turned push on for this browser, and with which token. Apart
 * from PushService so sign-out can read the token without loading the
 * service, which stays out of the first download.
 */
export interface StoredDevice {
  userId: string;
  token: string;
  /** When the token was last sent to the backend, ms since the epoch. */
  at: number;
}

const STORAGE_KEY = 'unibooks.push-device';

export function readStoredDevice(): StoredDevice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredDevice) : null;
  } catch {
    return null;
  }
}

export function writeStoredDevice(device: StoredDevice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
  } catch {
    // Without it the page just shows the switch off on the next visit.
  }
}

export function clearStoredDevice() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // See writeStoredDevice.
  }
}
