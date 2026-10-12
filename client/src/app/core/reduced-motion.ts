/**
 * The one thing the global `prefers-reduced-motion` block in styles.css cannot
 * reach.
 *
 * That block sets `scroll-behavior: auto !important`, which reads as if it
 * covers every scroll in the app. It does not: it only pins the CSS property.
 * A `behavior` passed to scrollTo / scrollBy / scrollIntoView is a script
 * argument, and the script argument outranks the stylesheet — so a photo
 * carousel or a category rail written in TypeScript kept gliding for users who
 * had asked the OS for the opposite. Every script-driven scroll therefore has
 * to ask for the preference itself, which is what this file is for.
 *
 * matchMedia is read per call rather than cached: the preference can be
 * toggled mid-session (macOS does it live), and a scroll happens rarely enough
 * that the query costs nothing. The guards mirror ThemeService's — matchMedia
 * is absent under SSR and can throw in some test environments, and the safe
 * answer there is "no preference expressed", i.e. the normal smooth scroll.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * The `behavior` to hand to scrollTo / scrollBy / scrollIntoView. Callers pass
 * this instead of a literal 'smooth' so the preference is applied in one place
 * and cannot be forgotten at a new call site.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
