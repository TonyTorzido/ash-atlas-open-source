import type {
  AuthSessionResponse, CreateWikiPageRequest, UpdateWikiPageRequest, WikiAccessResponse, WikiBuiltInArticle,
  WikiBuiltInCategory, WikiBuiltInCategoryId, WikiCollaborator, WikiMutationResponse, WikiPage, WikiPageListResponse, WikiPlayerSearchResult
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { AuthApiClient } from "../auth/authClient.js";
import { clientConfig } from "../config.js";
import { WikiArticleBody } from "./WikiArticleBody.js";
import { WikiArt } from "./wikiArt.js";
import {
  ArticleToc,
  Crest,
  EmberField,
  Flourish,
  ThemeToggle,
  useArticleToc,
  useParallax,
  useRevealOnScroll,
  useWikiTheme
} from "./wikiChrome.js";
import wikiBadge from "./assets/brand/wiki-badge.webp";
import wikiFavicon180 from "./assets/brand/wiki-favicon-180.png";
import wikiFavicon32 from "./assets/brand/wiki-favicon-32.png";
import wordmarkDark from "./assets/brand/wordmark-dark.webp";
import wordmarkLight from "./assets/brand/wordmark-light.webp";
import displayFontUrl from "./fonts/cinzel-latin-variable.woff?url";
import "./wiki.css";

type Draft = { slug: string; title: string; summary: string; body: string };
type WikiView = "pages" | "edit" | "team";
type WikiIndexEntry = { slug: string; title: string; summary: string; currentRevision: number; updatedAt: string; sourceType: "built-in" | "remote"; category?: WikiBuiltInCategoryId; searchText?: string };
type BuiltIn = Readonly<{ categories: readonly WikiBuiltInCategory[]; articles: readonly WikiBuiltInArticle[]; bySlug: ReadonlyMap<string, WikiBuiltInArticle> }>;
const NO_BUILT_IN: BuiltIn = { categories: [], articles: [], bySlug: new Map() };
const EMPTY_DRAFT: Draft = { slug: "", title: "", summary: "", body: "" };

type WikiGate =
  | { kind: "checking" }
  | { kind: "signed_out" }
  | { kind: "blocked"; devOnly: boolean }
  | { kind: "allowed"; session: AuthSessionResponse };

/** The wiki is signed-in content: nothing renders until the test-access gate admits the session. */
export function WikiApp(): React.JSX.Element {
  const [gate, setGate] = useState<WikiGate>({ kind: "checking" });
  useWikiTheme();
  useEffect(() => {
    let active = true;
    void new AuthApiClient(clientConfig.serverHttpBase).getSession().then((session: AuthSessionResponse) => {
      if (!active) return;
      if (!session.authenticated) setGate({ kind: "signed_out" });
      else if (session.testAccessAllowed !== true) setGate({ kind: "blocked", devOnly: session.testAccessDevOnly === true });
      else setGate({ kind: "allowed", session });
    }).catch(() => { if (active) setGate({ kind: "signed_out" }); });
    return () => { active = false; };
  }, []);
  if (gate.kind === "allowed") {
    return <WikiSite session={gate.session} onAccessLost={(status) => setGate(status === 401 ? { kind: "signed_out" } : { kind: "blocked", devOnly: false })} />;
  }
  return <div className="wiki-site wiki-site-home">
    <main className="wiki-page-view wiki-panel" id="wiki-main" aria-busy={gate.kind === "checking"}>
      {gate.kind === "checking" ? <p className="wiki-eyebrow" role="status">Checking your access…</p> : <header>
        <Crest className="wiki-missing-crest" />
        <p className="wiki-eyebrow">Ash Atlas Player Wiki</p>
        <h1>{gate.kind === "signed_out" ? "Sign in to read the wiki" : gate.devOnly ? "Developer access only" : "Waiting for test access"}</h1>
        <p className="wiki-lede">{gate.kind === "signed_out"
          ? "The player wiki is open to Ash Atlas test players. Sign in, then come back to this page."
          : gate.devOnly
            ? "Ash Atlas is temporarily limited to the development team. The wiki opens again with the game."
            : "The wiki opens once this account has test access."}</p>
        <Flourish />
        <div className="wiki-hero-actions"><a className="wiki-plaque" href="/play/">{gate.kind === "signed_out" ? "Sign in" : "Open Ash Atlas"}</a></div>
      </header>}
    </main>
  </div>;
}

function WikiSite({ session, onAccessLost }: { session: AuthSessionResponse; onAccessLost(status: 401 | 403): void }): React.JSX.Element {
  const [pages, setPages] = useState<WikiPageListResponse["pages"]>([]);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [builtIn, setBuiltIn] = useState<BuiltIn>(NO_BUILT_IN);
  const [staticArticle, setStaticArticle] = useState<WikiBuiltInArticle | null>(null);
  // Built-in articles only exist after the signed-in index loads, so deep links wait for it.
  const indexReady = useRef<Promise<BuiltIn>>(Promise.resolve(NO_BUILT_IN));
  const [access, setAccess] = useState<WikiAccessResponse["access"]>("none");
  const csrf = session.csrfToken;
  const [query, setQuery] = useState("");
  const [view, setView] = useState<WikiView>("pages");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(true);
  const [indexLoaded, setIndexLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [missingSlug, setMissingSlug] = useState<string | null>(null);
  const [theme, toggleTheme] = useWikiTheme();
  useEffect(() => {
    // Preload the display face so titles don't flash in the fallback serif.
    if (document.head.querySelector(`link[rel="preload"][href="${displayFontUrl}"]`)) return;
    const link = Object.assign(document.createElement("link"), { rel: "preload", href: displayFontUrl, as: "font", type: "font/woff", crossOrigin: "anonymous" });
    document.head.appendChild(link);
  }, []);
  useEffect(() => {
    // The wiki wears its own favicon; the game's icons in index.html stay untouched.
    const icons = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]'));
    const previous = icons.map((icon) => [icon, icon.href] as const);
    for (const icon of icons) icon.href = icon.rel === "apple-touch-icon" ? wikiFavicon180 : wikiFavicon32;
    return () => { for (const [icon, href] of previous) icon.href = href; };
  }, []);
  const pendingOperationKey = useRef<string | null>(null);
  const pageLoadSequence = useRef(0);
  const canEdit = access === "editor" || access === "owner";
  const isOwner = access === "owner";

  async function fetchIndex(): Promise<BuiltIn> {
    setBusy(true); setMessage(null);
    let loaded = NO_BUILT_IN;
    try {
      const result = await request<WikiPageListResponse>("/api/wiki");
      setPages(result.pages);
      const content = result.builtIn;
      if (content) loaded = { categories: content.categories, articles: content.articles, bySlug: new Map(content.articles.map((article) => [article.slug, article])) };
      setBuiltIn(loaded);
    }
    catch (error) { if (!reportAccessLoss(error)) setPages([]); }
    finally { setIndexLoaded(true); setBusy(false); }
    return loaded;
  }
  function loadIndex(): Promise<BuiltIn> {
    const next = fetchIndex();
    indexReady.current = next;
    return next;
  }
  useEffect(() => {
    void loadIndex();
    const syncPageFromLocation = () => {
      const slug = wikiSlugFromLocation();
      setView("pages");
      if (slug) {
        void openPage(slug, false);
      } else {
        pageLoadSequence.current += 1;
        pendingOperationKey.current = null;
        setPage(null); setStaticArticle(null); setDraft(EMPTY_DRAFT); setStale(false); setMessage(null); setBusy(false); setMissingSlug(null);
      }
    };
    syncPageFromLocation();
    window.addEventListener("popstate", syncPageFromLocation);
    if (!session.onboardingRequired) {
      void request<WikiAccessResponse>("/api/wiki-access").then((result) => setAccess(result.access)).catch(() => undefined);
    }
    return () => window.removeEventListener("popstate", syncPageFromLocation);
  }, []);
  function reportAccessLoss(error: unknown): boolean {
    if (!(error instanceof WikiApiError) || (error.status !== 401 && error.status !== 403)) return false;
    onAccessLost(error.status);
    return true;
  }

  const indexEntries = useMemo<WikiIndexEntry[]>(() => {
    const builtIns: WikiIndexEntry[] = builtIn.articles.map((article) => ({
      slug: article.slug, title: article.title, summary: article.summary, currentRevision: 0,
      updatedAt: "source-controlled", sourceType: "built-in" as const, category: article.category,
      searchText: `${article.title} ${article.summary} ${article.slug} ${article.tags.join(" ")}`
    }));
    const builtInSlugs = new Set(builtIns.map((entry) => entry.slug));
    return [...builtIns, ...pages.filter((candidate) => !builtInSlugs.has(candidate.slug)).map((candidate) => ({ ...candidate, sourceType: "remote" as const }))];
  }, [pages, builtIn]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? indexEntries.filter((candidate) => `${candidate.title} ${candidate.summary} ${candidate.slug} ${candidate.searchText ?? ""}`.toLocaleLowerCase().includes(needle)) : indexEntries;
  }, [indexEntries, query]);

  async function openPage(slug: string, navigate = true): Promise<void> {
    const loadSequence = ++pageLoadSequence.current;
    pendingOperationKey.current = null;
    setBusy(true); setMessage(null); setDrawerOpen(false);
    const article = (await indexReady.current).bySlug.get(slug);
    if (loadSequence !== pageLoadSequence.current) return;
    if (article) {
      setPage(null); setStaticArticle(article); setDraft(EMPTY_DRAFT); setStale(false); setView("pages"); setBusy(false); setMissingSlug(null);
      if (navigate) scrollToTop();
      if (navigate) window.history.pushState({}, "", `/wiki/${article.slug}`);
      return;
    }
    try {
      const next = await request<WikiPage>(`/api/wiki/${encodeURIComponent(slug)}`);
      if (loadSequence !== pageLoadSequence.current) return;
      setPage(next); setStaticArticle(null); setDraft(next); setStale(false); setView("pages"); setMissingSlug(null);
      if (navigate) { window.history.pushState({}, "", `/wiki/${next.slug}`); scrollToTop(); }
    }
    catch (error) {
      if (reportAccessLoss(error)) return;
      // Players see a friendly "not written yet" page instead of an API error.
      if (loadSequence === pageLoadSequence.current) {
        setPage(null); setStaticArticle(null); setView("pages"); setMissingSlug(slug);
      }
    }
    finally { if (loadSequence === pageLoadSequence.current) setBusy(false); }
  }
  function showIndex(): void {
    pageLoadSequence.current += 1; pendingOperationKey.current = null;
    setPage(null); setStaticArticle(null); setDraft(EMPTY_DRAFT); setView("pages"); setStale(false); setMessage(null); setBusy(false);
    setMissingSlug(null); setDrawerOpen(false);
    window.history.pushState({}, "", "/wiki");
    scrollToTop();
  }
  function startCreate(): void {
    pageLoadSequence.current += 1; pendingOperationKey.current = null;
    setPage(null); setStaticArticle(null); setDraft(EMPTY_DRAFT); setStale(false); setMessage(null); setBusy(false); setView("edit");
  }
  function startEdit(): void { pendingOperationKey.current = null; setStale(false); setMessage(null); setView("edit"); }
  async function save(): Promise<void> {
    setBusy(true); setMessage(null); setStale(false);
    try {
      const operationKey = pendingOperationKey.current ?? crypto.randomUUID();
      pendingOperationKey.current = operationKey;
      const result = page
        ? await request<WikiMutationResponse>(`/api/wiki/${encodeURIComponent(page.slug)}`, {
            method: "PUT", headers: mutationHeaders(csrf),
            body: JSON.stringify({ title: draft.title, summary: draft.summary, body: draft.body, expectedRevision: page.currentRevision, operationKey } satisfies UpdateWikiPageRequest)
          })
        : await request<WikiMutationResponse>("/api/wiki", {
            method: "POST", headers: mutationHeaders(csrf), body: JSON.stringify({ ...draft, operationKey } satisfies CreateWikiPageRequest)
          });
      setPage(result.page); setDraft(result.page); setView("pages");
      pendingOperationKey.current = null;
      window.history.replaceState({}, "", `/wiki/${result.page.slug}`);
      await loadIndex();
    } catch (error) {
      if (error instanceof WikiApiError && error.code === "WIKI_STALE_REVISION") setStale(true);
      setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  const currentSlug = staticArticle?.slug ?? page?.slug ?? null;
  const articleRail = Boolean(staticArticle || page || missingSlug);
  return <div className={`wiki-site${articleRail ? " wiki-site-article" : " wiki-site-home"}`}>
    <a className="wiki-skip-link" href="#wiki-main">Skip to content</a>
    <header className="wiki-site-header">
      <div className="wiki-header-inner">
        <button type="button" className="wiki-icon-button wiki-drawer-toggle" aria-expanded={drawerOpen} aria-controls="wiki-drawer"
          aria-label={drawerOpen ? "Close article list" : "Open article list"} onClick={() => setDrawerOpen((open) => !open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></svg>
        </button>
        <a className="wiki-brand" href="/wiki" onClick={(event) => { event.preventDefault(); showIndex(); }}>
          <span className="wiki-brand-mark" aria-hidden="true">
            <img className="wiki-wordmark wiki-wordmark-light" src={wordmarkLight} alt="" width={517} height={120} />
            <img className="wiki-wordmark wiki-wordmark-dark" src={wordmarkDark} alt="" width={515} height={120} />
            <img className="wiki-badge" src={wikiBadge} alt="" width={428} height={96} />
          </span>
          <span className="wiki-visually-hidden">Ash Atlas Player Wiki</span>
        </a>
        <nav className="wiki-sections" aria-label="Wiki sections">
          {WIKI_SECTIONS.map((section) => {
            const current = section.slug === null ? view === "pages" && !currentSlug && !missingSlug : currentSlug === section.slug;
            return <a key={section.label} href={section.slug ? `/wiki/${section.slug}` : "/wiki"} aria-current={current ? "page" : undefined}
              onClick={(event) => { event.preventDefault(); if (section.slug) void openPage(section.slug); else showIndex(); }}>{section.label}</a>;
          })}
        </nav>
        <div className="wiki-header-actions">
          {canEdit ? <button type="button" className="wiki-text-button" aria-current={view === "edit" ? "page" : undefined} onClick={() => page ? startEdit() : startCreate()}>Editor</button> : null}
          {isOwner ? <button type="button" className="wiki-text-button" aria-current={view === "team" ? "page" : undefined} onClick={() => setView("team")}>Team</button> : null}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <a className="wiki-plaque wiki-play" href="/play/">Play</a>
        </div>
      </div>
    </header>

    {message ? <div className="wiki-notice" role="status"><strong>{stale ? "Draft kept" : "Heads up"}</strong><span>{message}</span>{stale && page ? <button type="button" onClick={() => void openPage(page.slug)}>Reload current page</button> : null}</div> : null}

    {view === "pages" ? <main className="wiki-docs" id="wiki-main">
      <div className={`wiki-drawer-scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      <aside id="wiki-drawer" className={`wiki-drawer${drawerOpen ? " is-open" : ""}`} aria-label="Article directory">
        <label className="wiki-search"><span className="wiki-eyebrow">Search the guide</span><input aria-label="Search articles" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Creatures, smelting, travel…" /></label>
        {canEdit ? <button className="wiki-plaque wiki-primary-action" type="button" onClick={startCreate}>Create article</button> : null}
        <nav className="wiki-index" aria-label="Wiki articles">
          {indexLoaded && filtered.length === 0 ? <div className="wiki-empty"><strong>No articles found</strong><p>Try another search.</p></div> : null}
          {builtIn.categories.map((category) => {
            const categoryEntries = filtered.filter((candidate) => candidate.category === category.id);
            if (!categoryEntries.length) return null;
            return <section className={`wiki-index-group wiki-tone-${category.id}`} key={category.id}><h2>{category.label}</h2>{categoryEntries.map((candidate) => <button key={candidate.slug} type="button" aria-current={currentSlug === candidate.slug ? "page" : undefined} onClick={() => void openPage(candidate.slug)}>{candidate.title}</button>)}</section>;
          })}
          {filtered.some((candidate) => !candidate.category) ? <section className="wiki-index-group wiki-index-remote"><h2>Community articles</h2>{filtered.filter((candidate) => !candidate.category).map((candidate) => <button key={candidate.slug} type="button" aria-current={currentSlug === candidate.slug ? "page" : undefined} onClick={() => void openPage(candidate.slug)}>{candidate.title}</button>)}</section> : null}
        </nav>
      </aside>
      <div className="wiki-reader" key={currentSlug ?? missingSlug ?? "home"}>
        {staticArticle
          ? <StaticArticle article={staticArticle} articles={builtIn.articles} categories={builtIn.categories} onOpen={openPage} />
          : page
            ? <article className="wiki-article"><header className="wiki-article-header wiki-panel"><p className="wiki-eyebrow">Community article</p><h1>{page.title}</h1><p className="wiki-lede">{page.summary}</p><Flourish />{canEdit ? <button className="wiki-plaque" type="button" onClick={startEdit}>Edit this article</button> : null}</header><div className="wiki-article-body wiki-panel"><WikiBody body={page.body} /></div></article>
            : missingSlug
              ? <section className="wiki-missing wiki-panel"><Crest className="wiki-missing-crest" /><p className="wiki-eyebrow">Uncharted</p><h1>This page hasn't been written yet</h1><p className="wiki-lede">The road you followed leads off the map. Try the article list, or head back to the start.</p><Flourish /><div className="wiki-hero-actions"><button className="wiki-plaque" type="button" onClick={showIndex}>Back to the guide</button><button className="wiki-ghost-button" type="button" onClick={() => setDrawerOpen(true)}>Browse articles</button></div></section>
              : <WikiHome builtIn={builtIn} onOpen={openPage} communityArticles={indexEntries.filter((entry) => !entry.category)} />}
      </div>
    </main> : null}

    {view === "edit" && canEdit ? <main className="wiki-page-view wiki-panel" id="wiki-main"><header><p className="wiki-eyebrow">Wiki editor</p><h1>{page ? `Edit ${page.title}` : "Create an article"}</h1><p>{page ? `Your changes will create revision ${page.currentRevision + 1}.` : "Add a new page to the player guide."}</p></header><WikiEditor draft={draft} creating={!page} busy={busy} onChange={setDraft} onCancel={() => setView("pages")} onSave={() => void save()} /></main> : null}
    {view === "team" && isOwner ? <main className="wiki-page-view wiki-panel" id="wiki-main"><header><p className="wiki-eyebrow">Owner tools</p><h1>Wiki team</h1><p>Owners (Kings) manage the trusted team. Editors can create and revise articles.</p></header><WikiTeam csrf={csrf} /></main> : null}

    <footer className="wiki-site-footer"><Crest /><div><span>Ash Atlas Player Wiki</span><a href="/">Visit playashatlas.com</a></div></footer>
  </div>;
}

type WikiSection = Readonly<{ label: string; slug: string | null }>;
/** Top navigation; every entry points at a page that exists. */
const WIKI_SECTIONS: readonly WikiSection[] = [
  { label: "Guide", slug: null },
  { label: "Creatures", slug: "world/creatures" },
  { label: "Matchups", slug: "character/matchups" },
  { label: "Classes & Skills", slug: "character/classes" },
  { label: "World", slug: "world/world-map" }
];

type WikiHub = Readonly<{ slug: string; art: { kind: "monster" | "item"; id: string }; blurb: string }>;
const WIKI_HUBS: readonly WikiHub[] = [
  { slug: "world/creatures", art: { kind: "monster", id: "wolf" }, blurb: "Every beast of the wilds, from timid deer to legendary birds." },
  { slug: "character/matchups", art: { kind: "item", id: "starter_sword" }, blurb: "Know what to bring and what to wear before the first blow." },
  { slug: "character/classes", art: { kind: "item", id: "starter_staff" }, blurb: "Five classes, their innate gifts, and how skills unlock." },
  { slug: "world/world-map", art: { kind: "monster", id: "fire_bird" }, blurb: "Cities, manors, and kingdoms across thirteen biomes." },
  { slug: "activities/furnace", art: { kind: "item", id: "iron_bar" }, blurb: "Smelt ore into bars and cores, and master Metallurgy." },
  { slug: "kingdoms/overview", art: { kind: "item", id: "gold" }, blurb: "Raise a banner, share a treasury, and grow together." }
];

function WikiHome({ builtIn, onOpen, communityArticles }: { builtIn: BuiltIn; onOpen(slug: string): Promise<void>; communityArticles: WikiIndexEntry[] }): React.JSX.Element {
  const starters = builtIn.articles.filter((article) => article.category === "getting-started");
  const heroRef = useRef<HTMLElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  useParallax(artRef);
  useRevealOnScroll(homeRef, communityArticles.length);
  return <div className="wiki-welcome" ref={homeRef}>
    <section className="wiki-hero" ref={heroRef} aria-labelledby="wiki-hero-title">
      <div className="wiki-hero-art" ref={artRef}>
        <picture>
          <source media="(max-width: 700px)" srcSet="/landing/ash-atlas-landing-mobile.webp" />
          <img src="/landing/ash-atlas-landing-desktop.webp" alt="Ash Atlas field guide artwork" fetchPriority="high" />
        </picture>
      </div>
      <EmberField host={heroRef} />
      <div className="wiki-hero-copy">
        <Crest className="wiki-hero-crest" />
        <p className="wiki-eyebrow">The Ash Atlas field guide</p>
        <h1 id="wiki-hero-title">Welcome to the Ash Atlas Wiki.</h1>
        <p className="wiki-lede">Everything you need to explore, fight, craft, and rule. Learn the controls, read the bestiary, and find the right weapon for every foe.</p>
        <div className="wiki-hero-actions">
          <button className="wiki-plaque wiki-plaque-hero" type="button" onClick={() => void onOpen("getting-started/controls")}>Start here</button>
          <a className="wiki-ghost-button" href="/play/">Play now</a>
        </div>
      </div>
    </section>

    <section className="wiki-home-section" aria-labelledby="wiki-beginner-heading">
      <div className="wiki-section-heading wiki-reveal"><p className="wiki-eyebrow">New to Ash Atlas?</p><h2 id="wiki-beginner-heading">Start with the player loop</h2><Flourish /></div>
      <div className="wiki-card-grid wiki-card-grid-starters">{starters.map((article, index) => <button className="wiki-card wiki-reveal" style={{ "--wiki-stagger": index } as CSSProperties} type="button" key={article.slug} onClick={() => void onOpen(article.slug)}>
        <span className="wiki-card-step" aria-hidden="true">{index + 1}</span>
        <span className="wiki-eyebrow">{index === 0 ? "Start here" : "Next read"}</span>
        <strong>{article.title}</strong><span>{article.summary}</span>
      </button>)}</div>
    </section>

    <section className="wiki-home-section" aria-labelledby="wiki-hubs-heading">
      <div className="wiki-section-heading wiki-reveal"><p className="wiki-eyebrow">Explore the realm</p><h2 id="wiki-hubs-heading">Choose your path</h2><Flourish /></div>
      <div className="wiki-card-grid wiki-hub-grid">{WIKI_HUBS.map((hub, index) => {
        const article = builtIn.bySlug.get(hub.slug);
        if (!article) return null;
        return <a className={`wiki-hub wiki-reveal wiki-tone-${article.category}`} style={{ "--wiki-stagger": index } as CSSProperties} href={`/wiki/${article.slug}`} key={hub.slug}
          onClick={(event) => { event.preventDefault(); void onOpen(article.slug); }}>
          <span className="wiki-hub-art"><WikiArt kind={hub.art.kind} id={hub.art.id} name={article.title} /></span>
          <span className="wiki-eyebrow">{builtIn.categories.find((category) => category.id === article.category)?.label}</span>
          <strong>{article.title}</strong><span>{hub.blurb}</span>
        </a>;
      })}</div>
    </section>

    <section className="wiki-home-section wiki-topic-directory" id="wiki-topics" aria-labelledby="wiki-topics-heading">
      <div className="wiki-section-heading wiki-reveal"><p className="wiki-eyebrow">The full field guide</p><h2 id="wiki-topics-heading">Browse every topic</h2><Flourish /></div>
      <div className="wiki-topic-groups">{builtIn.categories.map((category, index) => {
        const articles = builtIn.articles.filter((article) => article.category === category.id);
        return <section className={`wiki-topic-group wiki-panel wiki-reveal wiki-tone-${category.id}`} style={{ "--wiki-stagger": index } as CSSProperties} key={category.id} aria-labelledby={`wiki-topic-${category.id}`}>
          <h3 id={`wiki-topic-${category.id}`}>{category.label}</h3><p>{category.description}</p>
          <ul>{articles.map((article) => <li key={article.slug}><a href={`/wiki/${article.slug}`} onClick={(event) => { event.preventDefault(); void onOpen(article.slug); }}>{article.title}</a></li>)}</ul>
        </section>;
      })}</div>
    </section>
    {communityArticles.length ? <section className="wiki-home-section wiki-community-directory" aria-labelledby="wiki-community-heading">
      <div className="wiki-section-heading wiki-reveal"><p className="wiki-eyebrow">From fellow adventurers</p><h2 id="wiki-community-heading">Community articles</h2><Flourish /></div>
      <div className="wiki-topic-groups"><section className="wiki-topic-group wiki-panel"><ul>{communityArticles.map((article) => <li key={article.slug}><a href={`/wiki/${article.slug}`} onClick={(event) => { event.preventDefault(); void onOpen(article.slug); }}>{article.title}</a></li>)}</ul></section></div>
    </section> : null}
  </div>;
}

function StaticArticle({ article, articles, categories, onOpen }: { article: WikiBuiltInArticle; articles: readonly WikiBuiltInArticle[]; categories: readonly WikiBuiltInCategory[]; onOpen(slug: string): Promise<void> }): React.JSX.Element {
  const category = categories.find((candidate) => candidate.id === article.category);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toc = useArticleToc(bodyRef, article.slug);
  const index = articles.indexOf(article);
  const previous = index > 0 ? articles[index - 1] : null;
  const next = index >= 0 && index < articles.length - 1 ? articles[index + 1] : null;
  return <div className={`wiki-article-layout${toc.length >= 2 ? " has-toc" : ""}`}>
    <article className={`wiki-article wiki-tone-${article.category}`}>
      <header className="wiki-article-header">
        <nav className="wiki-breadcrumbs" aria-label="Breadcrumb"><a href="/wiki">Guide</a><span aria-hidden="true">›</span><span>{category?.label ?? "Guide"}</span></nav>
        <h1>{article.title}</h1>
        <p className="wiki-lede">{article.summary}</p>
        <Flourish />
      </header>
      <div className="wiki-article-body wiki-panel"><div className="wiki-body" ref={bodyRef}><WikiArticleBody node={article.content} /></div></div>
      <nav className="wiki-pager" aria-label="More articles">
        {previous ? <a className="wiki-pager-link" href={`/wiki/${previous.slug}`} onClick={(event) => { event.preventDefault(); void onOpen(previous.slug); }}><span className="wiki-eyebrow">Previous</span><strong>{previous.title}</strong></a> : <span />}
        {next ? <a className="wiki-pager-link wiki-pager-next" href={`/wiki/${next.slug}`} onClick={(event) => { event.preventDefault(); void onOpen(next.slug); }}><span className="wiki-eyebrow">Next</span><strong>{next.title}</strong></a> : null}
      </nav>
    </article>
    <ArticleToc entries={toc} />
  </div>;
}

function WikiEditor({ draft, creating, busy, onChange, onCancel, onSave }: { draft: Draft; creating: boolean; busy: boolean; onChange(value: Draft): void; onCancel(): void; onSave(): void }) {
  return <form className="wiki-editor" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
    {creating ? <label>URL slug<input required maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={draft.slug} onChange={(event) => onChange({ ...draft, slug: event.target.value.toLowerCase() })} placeholder="getting-started" /></label> : null}
    <label>Title<input required maxLength={120} value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} /></label>
    <label>Summary<textarea required maxLength={500} rows={3} value={draft.summary} onChange={(event) => onChange({ ...draft, summary: event.target.value })} /></label>
    <label>Article text<textarea required maxLength={50000} rows={18} value={draft.body} onChange={(event) => onChange({ ...draft, body: event.target.value })} /><small>Use plain text. Lines beginning with # create headings; lines beginning with - create lists.</small></label>
    <div className="wiki-form-actions"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="wiki-primary-action" type="submit" disabled={busy}>{busy ? "Saving…" : creating ? "Create article" : "Save revision"}</button></div>
  </form>;
}

function WikiTeam({ csrf }: { csrf: string }) {
  const [collaborators, setCollaborators] = useState<WikiCollaborator[]>([]); const [players, setPlayers] = useState<WikiPlayerSearchResult[]>([]);
  const [query, setQuery] = useState(""); const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeIntent, setRemoveIntent] = useState<WikiCollaborator | null>(null);
  const load = () => request<{ collaborators: WikiCollaborator[] }>("/api/wiki-team").then((result) => setCollaborators(result.collaborators));
  useEffect(() => { void load().catch((error) => setMessage(errorMessage(error))); }, []);
  async function search() { setBusy(true); setMessage(null); try { setPlayers((await request<{ players: WikiPlayerSearchResult[] }>(`/api/wiki-team/players?q=${encodeURIComponent(query)}`)).players); } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); } }
  async function setRole(accountId: string, role: "owner" | "editor") { setBusy(true); setMessage(null); try { await request(`/api/wiki-team/${accountId}`, { method: "PUT", headers: mutationHeaders(csrf), body: JSON.stringify({ accountId, role }) }); await load(); } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); } }
  async function remove(accountId: string) { setBusy(true); setMessage(null); try { await request(`/api/wiki-team/${accountId}`, { method: "DELETE", headers: { "x-csrf-token": csrf } }); await load(); setRemoveIntent(null); } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); } }
  return <section className="wiki-team">
    {message ? <div className="wiki-inline-error" role="status">{message}</div> : null}
    <form className="wiki-team-search" onSubmit={(event) => { event.preventDefault(); void search(); }}><label>Find a player<input minLength={2} maxLength={40} required value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="wiki-primary-action" type="submit" disabled={busy}>{busy ? "Working…" : "Search"}</button></form>
    {players.length ? <section className="wiki-team-section"><h2>Search results</h2>{players.map((player) => <div className="wiki-team-row" key={player.accountId}><span>{player.playerName}</span><div><button type="button" disabled={busy} onClick={() => void setRole(player.accountId, "editor")}>Make Editor</button><button type="button" disabled={busy} onClick={() => void setRole(player.accountId, "owner")}>Make Owner</button></div></div>)}</section> : null}
    <section className="wiki-team-section"><h2>Current team</h2>{collaborators.length === 0 ? <p>No stored collaborators.</p> : collaborators.map((collaborator) => <div className="wiki-team-row" key={collaborator.accountId}><span><strong>{collaborator.playerName}</strong><small>{collaborator.role === "owner" ? "Owner (King)" : "Editor"}</small></span><button type="button" disabled={busy} onClick={() => setRemoveIntent(collaborator)}>Remove</button></div>)}</section>
    {removeIntent ? <WikiRemovalDialog collaborator={removeIntent} busy={busy} onConfirm={() => void remove(removeIntent.accountId)} onCancel={() => setRemoveIntent(null)} /> : null}
  </section>;
}

function WikiRemovalDialog({ collaborator, busy, onConfirm, onCancel }: { collaborator: WikiCollaborator; busy: boolean; onConfirm(): void; onCancel(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="wiki-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="wiki-dialog" role="dialog" aria-modal="true" aria-labelledby="wiki-remove-title" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}>
      <p className="wiki-kicker">Wiki team</p>
      <h2 id="wiki-remove-title">Remove {collaborator.playerName} from the wiki team?</h2>
      <p>{collaborator.playerName} will immediately lose {collaborator.role === "owner" ? "Owner" : "Editor"} access.</p>
      <div className="wiki-form-actions"><button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="wiki-danger-action" type="button" disabled={busy} onClick={onConfirm}>{busy ? "Removing…" : "Remove access"}</button></div>
    </section>
  </div>;
}

function WikiBody({ body }: { body: string }) {
  const nodes: React.ReactNode[] = []; let list: string[] = [];
  const flush = () => { if (list.length) { nodes.push(<ul key={`list-${nodes.length}`}>{list.map((item, i) => <li key={i}>{item}</li>)}</ul>); list = []; } };
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("- ")) { list.push(line.slice(2)); continue; } flush();
    if (line.startsWith("### ")) nodes.push(<h4 key={nodes.length}>{line.slice(4)}</h4>);
    else if (line.startsWith("## ")) nodes.push(<h3 key={nodes.length}>{line.slice(3)}</h3>);
    else if (line.startsWith("# ")) nodes.push(<h2 key={nodes.length}>{line.slice(2)}</h2>);
    else if (line.trim()) nodes.push(<p key={nodes.length}>{line}</p>);
  } flush(); return <div className="wiki-body">{nodes}</div>;
}

class WikiApiError extends Error { constructor(readonly code: string, message: string, readonly status = 0) { super(message); } }
async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, clientConfig.serverHttpBase), { ...init, credentials: "include" });
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new WikiApiError(payload?.error?.code ?? "WIKI_UNAVAILABLE", payload?.error?.message ?? "The wiki is temporarily unavailable", response.status);
  return payload as T;
}
function mutationHeaders(csrf: string) { return { "content-type": "application/json", "x-csrf-token": csrf }; }
function scrollToTop(): void {
  (document.scrollingElement ?? document.documentElement).scrollTop = 0;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "The wiki is temporarily unavailable"; }
function wikiSlugFromLocation(): string | null {
  if (!window.location.pathname.startsWith("/wiki/")) return null;
  return window.location.pathname.slice("/wiki/".length).replace(/\/$/, "") || null;
}
