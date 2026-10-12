// @ts-ignore - Node's fs, available to the test runner.
import { readFileSync } from 'node:fs';

/**
 * public/sw.js: Angular's service worker with other origins left to the
 * browser. Run against a stand-in `self`, it must stop cross-origin fetch
 * events before ngsw-worker.js sees them, pass same-origin ones through, and
 * load ngsw-worker.js after registering its own listener.
 */
describe('sw.js', () => {
  function load() {
    const listeners: ((event: any) => void)[] = [];
    const order: string[] = [];
    const self = {
      location: { origin: 'https://cycleunife.pages.dev' },
      addEventListener: (type: string, fn: (event: any) => void) => {
        if (type === 'fetch') { listeners.push(fn); order.push('listener'); }
      },
    };
    const importScripts = (url: string) => order.push(`import ${url}`);
    const source = readFileSync('public/sw.js', 'utf8');
    new Function('self', 'importScripts', source)(self, importScripts);
    const dispatch = (url: string) => {
      const event = { request: { url }, stopImmediatePropagation: vi.fn() };
      listeners.forEach(fn => fn(event));
      return event.stopImmediatePropagation;
    };
    return { order, dispatch };
  }

  it('registers its listener before loading Angular\'s worker', () => {
    expect(load().order).toEqual(['listener', 'import ./ngsw-worker.js']);
  });

  it('keeps other origins away from Angular\'s worker', () => {
    const { dispatch } = load();
    expect(dispatch('https://fonts.gstatic.com/s/notosanstc/v39/x.woff2')).toHaveBeenCalled();
    expect(dispatch('https://cycle-uni-be.vercel.app/api/v1/core/metadata/')).toHaveBeenCalled();
  });

  it('leaves same-origin requests to Angular\'s worker', () => {
    const { dispatch } = load();
    expect(dispatch('https://cycleunife.pages.dev/chunk-ABC.js')).not.toHaveBeenCalled();
    expect(dispatch('https://cycleunife.pages.dev/tw/search')).not.toHaveBeenCalled();
  });
});
