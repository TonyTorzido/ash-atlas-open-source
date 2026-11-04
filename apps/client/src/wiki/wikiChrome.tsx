import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

export type WikiTheme = "light" | "dark";
const THEME_KEY = "ashAtlas.wiki.theme.v1";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function initialTheme(): WikiTheme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* Private browsing: fall back to the system preference. */ }
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Light vellum or dark leather, shared with the game's menu palette tokens. */
export function useWikiTheme(): readonly [WikiTheme, () => void] {
  const [theme, setTheme] = useState<WikiTheme>(initialTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.menuTheme = theme;
    document.documentElement.dataset.wikiTheme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try { window.localStorage.setItem(THEME_KEY, next); } catch { /* Theme still applies for this visit. */ }
      return next;
    });
  }, []);
  return [theme, toggle] as const;
}

export function ThemeToggle({ theme, onToggle }: { theme: WikiTheme; onToggle(): void }): ReactNode {
  const next = theme === "dark" ? "light" : "dark";
  return <button type="button" className="wiki-icon-button wiki-theme-toggle" onClick={onToggle} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
    {theme === "dark"
      ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></svg>
      : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8a8.4 8.4 0 1 0 10.8 10.8Z" /></svg>}
  </button>;
}

/** Gilded divider flourish (art-kit scrollwork, recolored by the theme through a CSS mask). */
export function Flourish({ className = "" }: { className?: string }): ReactNode {
  return <span className={`wiki-flourish ${className}`.trim()} aria-hidden="true" />;
}

/** The banner-over-shield crest, recolored by the theme. */
export function Crest({ className = "" }: { className?: string }): ReactNode {
  return <span className={`wiki-crest ${className}`.trim()} aria-hidden="true" />;
}

const EMBERS = Array.from({ length: 22 }, (_, index) => ({
  left: (index * 37) % 100,
  delay: -((index * 1.7) % 14),
  duration: 9 + ((index * 5) % 9),
  size: 2 + (index % 4),
  drift: ((index * 13) % 40) - 20
}));

/** Drifting embers over the hero; paused whenever the hero is offscreen. */
export function EmberField({ host }: { host: RefObject<HTMLElement | null> }): ReactNode {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPaused(!entry?.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);
  return <div className={`wiki-embers${paused ? " is-paused" : ""}`} aria-hidden="true">
    {EMBERS.map((ember, index) => <span key={index} style={{
      "--x": `${ember.left}%`, "--delay": `${ember.delay}s`, "--duration": `${ember.duration}s`,
      "--size": `${ember.size}px`, "--drift": `${ember.drift}px`
    } as CSSProperties} />)}
  </div>;
}

/** Gentle parallax for the hero art; disabled when motion is reduced. */
export function useParallax(target: RefObject<HTMLElement | null>, strength = 0.18): void {
  useEffect(() => {
    const element = target.current;
    if (!element || prefersReducedMotion()) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      element.style.transform = `translate3d(0, ${Math.round(window.scrollY * strength)}px, 0) scale(1.02)`;
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    window.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { window.removeEventListener("scroll", onScroll); if (frame) window.cancelAnimationFrame(frame); };
  }, [target, strength]);
}

/** Adds `is-visible` to `.wiki-reveal` children as they scroll into view (staggered by CSS). */
export function useRevealOnScroll(root: RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const targets = Array.from(container.querySelectorAll<HTMLElement>(".wiki-reveal"));
    if (typeof IntersectionObserver === "undefined" || prefersReducedMotion()) {
      for (const target of targets) target.classList.add("is-visible");
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px" });
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [root, key]);
}

export type TocEntry = Readonly<{ id: string; label: string }>;

function headingId(label: string): string {
  return label.toLocaleLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Reads the article's own section headings for the in-page contents. */
export function useArticleToc(body: RefObject<HTMLElement | null>, key: unknown): readonly TocEntry[] {
  const [entries, setEntries] = useState<readonly TocEntry[]>([]);
  useEffect(() => {
    const container = body.current;
    if (!container) { setEntries([]); return; }
    const headings = Array.from(container.querySelectorAll<HTMLHeadingElement>(":scope > h2"));
    setEntries(headings.map((heading) => {
      const label = heading.textContent ?? "";
      heading.id ||= `section-${headingId(label)}`;
      return { id: heading.id, label };
    }));
  }, [body, key]);
  return entries;
}

export function ArticleToc({ entries }: { entries: readonly TocEntry[] }): ReactNode {
  const [active, setActive] = useState<string | null>(entries[0]?.id ?? null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    setActive(entries[0]?.id ?? null);
    if (typeof IntersectionObserver === "undefined" || !entries.length) return;
    const observer = new IntersectionObserver((records) => {
      const visible = records.filter((record) => record.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: "-20% 0px -65% 0px" });
    for (const entry of entries) {
      const heading = document.getElementById(entry.id);
      if (heading) observer.observe(heading);
    }
    return () => observer.disconnect();
  }, [entries]);
  if (entries.length < 2) return null;
  return <nav className="wiki-toc" aria-label="On this page">
    <p className="wiki-eyebrow">On this page</p>
    <ol ref={listRef}>{entries.map((entry) => <li key={entry.id}>
      <a href={`#${entry.id}`} aria-current={active === entry.id ? "location" : undefined}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(entry.id)?.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
          setActive(entry.id);
        }}>{entry.label}</a>
    </li>)}</ol>
  </nav>;
}
