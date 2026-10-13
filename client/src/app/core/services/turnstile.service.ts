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
 * Cloudflare Turnstile, loaded only when a sign-in asks for it (after
 * repeated wrong passwords on one account; see server routes/accounts.ts).
 * The site key comes from server/wrangler.jsonc vars (TURNSTILE_SITE_KEY);
 * without one the feature is off and the server never asks.
 */
@Injectable({ providedIn: 'root' })
export class TurnstileService {
  readonly siteKey = environment.turnstileSiteKey || '';
  private api: Promise<TurnstileApi> | null = null;

  get enabled(): boolean {
    return !!this.siteKey;
  }

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
   * Show a challenge in `el`; `onToken` gets each token the visitor earns
   * (a token is single-use: call `reset` after it has been sent). Resolves
   * with the widget id.
   */
  async render(
    el: HTMLElement,
    opts: {
      language: string;
      theme: 'light' | 'dark';
      onToken: (token: string) => void;
      onError: () => void;
    },
  ): Promise<string> {
    const api = await this.load();
    return api.render(el, {
      sitekey: this.siteKey,
      language: opts.language,
      theme: opts.theme,
      callback: opts.onToken,
      'error-callback': opts.onError,
      'expired-callback': opts.onError,
    });
  }

  reset(widgetId: string): void {
    window.turnstile?.reset(widgetId);
  }

  remove(widgetId: string): void {
    window.turnstile?.remove(widgetId);
  }
}
