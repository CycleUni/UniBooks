import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Cloudflare Turnstile. Pages that always need a challenge (registration,
 * asking for a reset link) show it as soon as they open, with the build's
 * `siteKey`; sign-in loads it only when the server asks (after repeated
 * wrong passwords; see server routes/accounts.ts), with the site key in that
 * answer. The site key is public and shared with the server: set-env.js reads
 * it from server/wrangler.jsonc vars (or .dev.vars locally). Empty when none
 * is configured, and then the server never asks either.
 */
@Injectable({ providedIn: 'root' })
export class TurnstileService {
  readonly siteKey: string = environment.turnstileSiteKey;
  private api: Promise<TurnstileApi> | null = null;

  private load(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    this.api ??= new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () =>
        window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
      script.onerror = () => {
        this.api = null;
        reject(new Error('Turnstile did not load'));
      };
      document.head.appendChild(script);
    });
    return this.api;
  }

  /**
   * Add a challenge to `el`; `onToken` gets each token the visitor earns (a
   * token is single-use: call `reset` for a new one). Resolves with the
   * widget id. It shows nothing while Cloudflare can verify the visitor
   * without them (`interaction-only`), so `el` takes no room until then;
   * `onInteractive` says when it needs the visitor (true) and when they are
   * done (false). `onError` covers a failed check, an expired token, a
   * timeout and an unsupported browser.
   */
  async render(
    el: HTMLElement,
    opts: {
      siteKey: string;
      language: string;
      theme: 'light' | 'dark';
      onToken: (token: string) => void;
      onError: () => void;
      onInteractive: (needed: boolean) => void;
    },
  ): Promise<string> {
    const api = await this.load();
    return api.render(el, {
      sitekey: opts.siteKey,
      language: opts.language,
      theme: opts.theme,
      callback: opts.onToken,
      appearance: 'interaction-only',
      'before-interactive-callback': () => opts.onInteractive(true),
      'after-interactive-callback': () => opts.onInteractive(false),
      'error-callback': opts.onError,
      'expired-callback': opts.onError,
      'timeout-callback': opts.onError,
      'unsupported-callback': opts.onError,
    });
  }

  reset(widgetId: string): void {
    window.turnstile?.reset(widgetId);
  }

  remove(widgetId: string): void {
    window.turnstile?.remove(widgetId);
  }
}
