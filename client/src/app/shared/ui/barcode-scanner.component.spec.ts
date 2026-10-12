import { createScanConfirmer, selectBestRearCamera, visibleVideoRegion } from './barcode-scanner.component';
import { isValidIsbnChecksum } from '../../core/isbn';

describe('selectBestRearCamera', () => {
  it('returns null for empty or null camera list', () => {
    expect(selectBestRearCamera([])).toBeNull();
    expect(selectBestRearCamera(null)).toBeNull();
    expect(selectBestRearCamera(undefined)).toBeNull();
  });

  it('selects normal back camera avoiding ultra wide and telephoto', () => {
    const devices = [
      { id: 'cam-front', label: 'Front Camera' },
      { id: 'cam-ultra', label: 'Back Ultra Wide Camera (0.5x)' },
      { id: 'cam-main', label: 'Back Camera' },
      { id: 'cam-tele', label: 'Back Telephoto Camera (3x)' }
    ];
    expect(selectBestRearCamera(devices)).toBe('cam-main');
  });

  it('handles localized Chinese camera labels correctly', () => {
    const devices = [
      { id: 'cam1', label: '前置相機' },
      { id: 'cam2', label: '後置超廣角鏡頭' },
      { id: 'cam3', label: '後置廣角主相機' }
    ];
    expect(selectBestRearCamera(devices)).toBe('cam3');
  });

  it('returns null if labels are unspecific (falls back to facingMode: environment)', () => {
    const devices = [
      { id: 'cam1', label: 'camera2 0, facing back' },
      { id: 'cam2', label: 'camera2 1, facing front' }
    ];
    expect(selectBestRearCamera(devices)).toBeNull();
  });

  it('returns null if labels are empty/opaque (falls back to facingMode: environment)', () => {
    const devices = [
      { id: 'cam1', label: '' },
      { id: 'cam2', label: '' }
    ];
    expect(selectBestRearCamera(devices)).toBeNull();
  });
});

describe('createScanConfirmer', () => {
  // A fake clock: each read happens `step` ms after the previous one.
  const clock = (step: number) => { let t = 0; return () => (t += step); };

  it('passes a value on its third consecutive read once 400ms have passed', () => {
    const confirmed = createScanConfirmer(3, 400, clock(200));
    expect(confirmed('9780134685991')).toBe(false);
    expect(confirmed('9780134685991')).toBe(false);
    expect(confirmed('9780134685991')).toBe(true);
  });

  it('does not let a burst of reads of one frame confirm itself', () => {
    // Three decodes 10ms apart are almost certainly the same camera frame.
    const confirmed = createScanConfirmer(3, 400, clock(10));
    for (let i = 0; i < 10; i++) expect(confirmed('9780134601991')).toBe(false);
  });

  it('restarts the count and the clock when a different value is read in between', () => {
    const confirmed = createScanConfirmer(3, 400, clock(200));
    expect(confirmed('9780134685991')).toBe(false);
    expect(confirmed('9780134685991')).toBe(false);
    // A misread with two digits wrong that still passes the EAN-13 check digit.
    expect(isValidIsbnChecksum('9780134601991')).toBe(true);
    expect(confirmed('9780134601991')).toBe(false);
    expect(confirmed('9780134685991')).toBe(false);
    expect(confirmed('9780134685991')).toBe(false);
    expect(confirmed('9780134685991')).toBe(true);
  });
});

describe('visibleVideoRegion', () => {
  it('takes the centre band of a portrait video shown in a 16:9 frame', () => {
    // A phone's 480x640 portrait stream in a 352x198 frame: full width, centre 270 rows.
    expect(visibleVideoRegion(480, 640, 352, 198)).toEqual({ x: 0, y: 185, width: 480, height: 270 });
  });

  it('takes the centre columns of a video wider than the frame', () => {
    expect(visibleVideoRegion(1920, 1080, 400, 400)).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
  });

  it('takes the whole video when the shapes match', () => {
    expect(visibleVideoRegion(1280, 720, 320, 180)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });
});
