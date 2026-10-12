import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, OnDestroy, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';

/**
 * Makes sure a BarcodeDetector that reads EAN-13 exists. Android Chrome ships
 * a native detector; iOS Safari has none, so the polyfill runs ZXing-C++ as
 * WebAssembly instead, served from our own origin (see the zxing asset in
 * angular.json) rather than its default CDN.
 */
export async function ensureEan13BarcodeDetector(): Promise<void> {
  const native = (globalThis as any).BarcodeDetector;
  if (native) {
    try {
      const formats: string[] = await native.getSupportedFormats();
      if (formats.includes('ean_13')) return;
    } catch {
      // Treat a detector that can't list its formats like a missing one.
    }
  }
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? `/zxing/${path}` : prefix + path,
    },
  });
  (globalThis as any).BarcodeDetector = BarcodeDetector;
}

/**
 * Returns a filter that passes a decoded value only once it has been read
 * `reads` times in a row over at least `minSpanMs`. A misread can change two
 * digits so that the EAN-13 check digit still holds (seen on Android and iOS,
 * where it opened a different book); a misread holding steady across several
 * camera frames is far less likely than the true value doing so.
 *
 * The time span matters as much as the count: the scanner decodes ~10 times a
 * second, but in low light the camera delivers frames more slowly, so
 * back-to-back decodes can be the same frame read twice. Requiring two reads
 * alone let one bad frame confirm itself.
 */
export function createScanConfirmer(
  reads = 3,
  minSpanMs = 400,
  now: () => number = () => performance.now(),
): (decodedText: string) => boolean {
  let last = '';
  let count = 0;
  let firstSeenAt = 0;
  return (decodedText: string) => {
    const t = now();
    if (decodedText === last) {
      count++;
    } else {
      last = decodedText;
      count = 1;
      firstSeenAt = t;
    }
    return count >= reads && t - firstSeenAt >= minSpanMs;
  };
}

/**
 * Selects the most appropriate rear camera from available video devices only when
 * there is high confidence from device labels (e.g. avoiding explicitly labeled
 * ultra-wide or telephoto lenses on multi-lens iOS devices).
 *
 * If labels are generic, uninformative (e.g. Android "camera2 0"), or ambiguous,
 * returns null to let the browser choose naturally via { facingMode: "environment" }.
 */
export function selectBestRearCamera(devices: { id: string; label: string }[] | null | undefined): string | null {
  if (!devices || devices.length === 0) return null;

  // Filter out front-facing cameras
  const frontRegex = /front|user|前置|前相機|前鏡頭|facetime|selfie/i;
  const backDevices = devices.filter(d => !frontRegex.test(d.label || ''));
  if (backDevices.length <= 1) {
    // If only 0 or 1 back camera candidate, let browser handle facingMode natively
    return null;
  }

  // Avoid ultra-wide and telephoto lenses
  const ultraWideRegex = /ultra[\s-]?wide|0\.5x|超廣角/i;
  const telephotoRegex = /telephoto|望遠|長焦|[2-9]x/i;

  const hasSpecialtyLens = backDevices.some(d =>
    ultraWideRegex.test(d.label || '') || telephotoRegex.test(d.label || '')
  );

  // If none of the devices have explicit ultra-wide or telephoto labels,
  // we do not have high confidence in the label scheme — fall back to browser facingMode.
  if (!hasSpecialtyLens) {
    return null;
  }

  const normalBackCameras = backDevices.filter(d =>
    !ultraWideRegex.test(d.label || '') && !telephotoRegex.test(d.label || '')
  );

  if (normalBackCameras.length === 0) {
    return null;
  }

  // If there is one explicitly labeled as main / wide / back camera, prefer it
  const preferred = normalBackCameras.find(d =>
    /back camera|main|廣角|後置|後相機/i.test(d.label || '')
  );

  return preferred ? preferred.id : normalBackCameras[0].id;
}

/**
 * The part of a video shown in an element sized `boxWidth` x `boxHeight` with
 * `object-fit: cover`, in the video's own pixels: the whole of one dimension
 * and the centre of the other.
 */
export function visibleVideoRegion(
  videoWidth: number,
  videoHeight: number,
  boxWidth: number,
  boxHeight: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(boxWidth / videoWidth, boxHeight / videoHeight);
  const width = Math.min(videoWidth, Math.round(boxWidth / scale));
  const height = Math.min(videoHeight, Math.round(boxHeight / scale));
  return {
    x: Math.round((videoWidth - width) / 2),
    y: Math.round((videoHeight - height) / 2),
    width,
    height,
  };
}

/** Zoom applied when the camera supports it; see applyCameraTuning. */
const PREFERRED_ZOOM = 1.5;
/** At most this many decodes a second; slower devices go as fast as they can. */
const MAX_DECODES_PER_SECOND = 10;

/**
 * The camera view that reads a book's barcode, shared by the sell form and the
 * search screen. It starts the rear camera when rendered and stops it when
 * removed, so a page shows it with `*ngIf` while scanning.
 *
 * Every frame shown is decoded at the camera's own resolution: the guide
 * corners only show where to aim. (html5-qrcode, used before, shrank a fixed
 * 280x120 box to that many pixels before decoding, so a barcode held at arm's
 * length blurred into too few pixels per bar.) A decode starts only after the
 * last one finished, so a slow device skips frames instead of queueing them.
 *
 * It emits each code once it holds steady across frames (createScanConfirmer)
 * and leaves judging it to the page — isbnFromScan in core/isbn.ts — since
 * what an unusable code means differs by page. `failed` means the camera could
 * not be opened (permission denied, no camera); the page should close it.
 */
@Component({
  selector: 'ui-barcode-scanner',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <video #video class="video" muted playsinline autoplay></video>
    <div class="guide" aria-hidden="true"></div>
    <button
      *ngIf="torchSupported"
      type="button"
      class="torch"
      [class.on]="torchOn"
      [attr.aria-pressed]="torchOn"
      [attr.aria-label]="(torchOn ? 'scanner.torchOff' : 'scanner.torchOn') | t"
      (click)="toggleTorch()"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
           stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">
        <path d="M7 2h10v4l-2 4v11a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V10L7 6z"/>
        <line x1="7" y1="6" x2="17" y2="6"/>
        <line x1="12" y1="13" x2="12" y2="15"/>
      </svg>
    </button>
  `,
  styles: [`
    :host {
      position: relative;
      display: block;
      width: 100%;
      max-width: 100%;
      aspect-ratio: 16 / 9;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--line);
      background: #000;
    }
    /* The camera's own shape (portrait on a phone) is cropped to fill the
       frame, so the frame's centre, where the guide is drawn, is the video's. */
    .video {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    /* Corner marks around a wide band, the shape of a book's barcode. */
    .guide {
      position: absolute;
      left: 10%;
      right: 10%;
      top: 25%;
      bottom: 25%;
      pointer-events: none;
      --c: rgba(255, 255, 255, 0.9);
      --l: 20px;
      background:
        linear-gradient(var(--c), var(--c)) top left / var(--l) 3px,
        linear-gradient(var(--c), var(--c)) top left / 3px var(--l),
        linear-gradient(var(--c), var(--c)) top right / var(--l) 3px,
        linear-gradient(var(--c), var(--c)) top right / 3px var(--l),
        linear-gradient(var(--c), var(--c)) bottom left / var(--l) 3px,
        linear-gradient(var(--c), var(--c)) bottom left / 3px var(--l),
        linear-gradient(var(--c), var(--c)) bottom right / var(--l) 3px,
        linear-gradient(var(--c), var(--c)) bottom right / 3px var(--l);
      background-repeat: no-repeat;
    }
    .torch {
      position: absolute;
      right: 8px;
      bottom: 8px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 50%;
      color: #fff;
      background: rgba(0, 0, 0, 0.5);
      cursor: pointer;
    }
    .torch.on {
      color: #000;
      background: rgba(255, 255, 255, 0.9);
    }
  `]
})
export class UiBarcodeScanner implements AfterViewInit, OnDestroy {
  /** A code read steadily; not yet checked to be an ISBN. */
  @Output() decoded = new EventEmitter<string>();
  /** The camera could not be started. */
  @Output() failed = new EventEmitter<void>();

  @ViewChild('video', { static: true }) private videoRef!: ElementRef<HTMLVideoElement>;

  torchSupported = false;
  torchOn = false;

  private stream: MediaStream | null = null;
  private destroyed = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: ElementRef<HTMLElement>, private cdr: ChangeDetectorRef) {}

  ngAfterViewInit() {
    this.start();
  }

  ngOnDestroy() {
    this.destroyed = true;
    if (this.loopTimer !== null) clearTimeout(this.loopTimer);
    this.stopStream();
  }

  async toggleTorch() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const on = !this.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as any] });
      this.torchOn = on;
    } catch (err) {
      console.warn('Torch toggle failed', err);
    }
    this.cdr.markForCheck();
  }

  private async start() {
    try {
      await ensureEan13BarcodeDetector();
      const detector = new (globalThis as any).BarcodeDetector({ formats: ['ean_13'] });
      let stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });

      // Camera labels are only readable once permission is granted, so the
      // main lens (e.g. on multi-lens iPhones) can be picked only now.
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices())
          .filter(d => d.kind === 'videoinput')
          .map(d => ({ id: d.deviceId, label: d.label }));
        const best = selectBestRearCamera(devices);
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (best && best !== current) {
          stream.getTracks().forEach(t => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: best } },
            audio: false,
          });
        }
      } catch (e) {
        console.warn('Camera enumeration fallback to facingMode', e);
      }

      this.stream = stream;
      if (this.destroyed) {
        this.stopStream();
        return;
      }
      await this.applyCameraTuning(stream.getVideoTracks()[0]);

      const video = this.videoRef.nativeElement;
      video.srcObject = stream;
      await video.play();
      if (this.destroyed) return;
      this.scanLoop(video, detector, createScanConfirmer());
    } catch (err) {
      console.error('Scanner error', err);
      this.stopStream();
      if (!this.destroyed) this.failed.emit();
    }
  }

  /**
   * Continuous focus, a slight zoom and the torch button, each only where the
   * camera reports it. The zoom makes people hold the book farther away:
   * newer iPhones' main lens can't focus closer than ~15-20cm, so a book held
   * right up to it stays blurred.
   */
  private async applyCameraTuning(track: MediaStreamTrack | undefined) {
    if (!track || typeof track.getCapabilities !== 'function') return;
    const caps = track.getCapabilities() as any;
    const advanced: any[] = [];
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' });
    }
    if (caps.zoom && caps.zoom.min <= PREFERRED_ZOOM && caps.zoom.max >= PREFERRED_ZOOM) {
      advanced.push({ zoom: PREFERRED_ZOOM });
    }
    // One at a time, so a setting the camera rejects doesn't take the others with it.
    for (const constraint of advanced) {
      try {
        await track.applyConstraints({ advanced: [constraint] });
      } catch (err) {
        console.warn('Camera constraint not applied', constraint, err);
      }
    }
    this.torchSupported = caps.torch === true;
    this.cdr.markForCheck();
  }

  private scanLoop(video: HTMLVideoElement, detector: any, confirmed: (text: string) => boolean) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const minInterval = 1000 / MAX_DECODES_PER_SECOND;

    const tick = async () => {
      if (this.destroyed) return;
      const startedAt = performance.now();
      const box = this.host.nativeElement;
      if (context && video.videoWidth && box.clientWidth && box.clientHeight) {
        const region = visibleVideoRegion(video.videoWidth, video.videoHeight, box.clientWidth, box.clientHeight);
        if (canvas.width !== region.width) canvas.width = region.width;
        if (canvas.height !== region.height) canvas.height = region.height;
        context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
        try {
          const codes: { rawValue: string }[] = await detector.detect(canvas);
          if (!this.destroyed && codes.length > 0 && confirmed(codes[0].rawValue)) {
            this.decoded.emit(codes[0].rawValue);
          }
        } catch (err) {
          console.warn('Barcode decode failed', err);
        }
      }
      if (this.destroyed) return;
      const elapsed = performance.now() - startedAt;
      this.loopTimer = setTimeout(tick, Math.max(0, minInterval - elapsed));
    };
    tick();
  }

  private stopStream() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    const video = this.videoRef?.nativeElement;
    if (video) video.srcObject = null;
  }
}
