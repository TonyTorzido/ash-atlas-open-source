import {
  ENCHANTMENT_STONE_VARIANTS,
  PLAYER_PACKAGE_ADMIN_API_BASE,
  PLAYER_PACKAGE_LIMITS,
  type PlayerPackageAssetKind,
  type PlayerPackageCampaignSummary,
  type PlayerPackageCatalogItem,
  type PlayerPackageCharacterSearchResult
} from "@ash-atlas/shared";
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

type Props = {
  serverHttpBase?: string | undefined;
  csrfToken?: string | undefined;
};

type PackageLine = {
  itemKind: PlayerPackageAssetKind;
  itemId: string;
  variant: string | null;
  quantity: number;
};

type CharacterPage = {
  characters: PlayerPackageCharacterSearchResult[];
  nextCursor: string | null;
};

export function DeveloperPackagesPanel({
  serverHttpBase,
  csrfToken
}: Props): React.JSX.Element {
  const [catalog, setCatalog] = useState<readonly PlayerPackageCatalogItem[]>([]);
  const [eligibleCount, setEligibleCount] = useState<number | null>(null);
  const [catalogState, setCatalogState] =
    useState<"loading" | "ready" | "error">("loading");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly PlayerPackageCampaignSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<"specific" | "all">("specific");
  const [recipients, setRecipients] =
    useState<readonly PlayerPackageCharacterSearchResult[]>([]);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false);
  const [searchResults, setSearchResults] =
    useState<readonly PlayerPackageCharacterSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeOption, setActiveOption] = useState(-1);
  const [itemSearch, setItemSearch] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedVariant, setSelectedVariant] = useState("default");
  const [quantity, setQuantity] = useState(1);
  const [lines, setLines] = useState<readonly PackageLine[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [allConfirmation, setAllConfirmation] = useState("");
  const [operationKey, setOperationKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const filteredCatalog = useMemo(() => {
    const search = itemSearch.trim().toLocaleLowerCase();
    return catalog.filter((item) => {
      const searchTerms = [
        item.itemId,
        item.displayName,
        item.category,
        ...item.supportedVariants,
        ...(item.itemId === "enchantment_stone" ? ["gem", "gems", "gemstone"] : [])
      ];
      return !search || searchTerms.some((term) =>
        term.toLocaleLowerCase().includes(search)
      );
    });
  }, [catalog, itemSearch]);
  const selectedCatalogItem =
    filteredCatalog.find((item) => item.itemId === selectedItemId) ??
    filteredCatalog[0] ??
    null;
  const searchedVariant = selectedCatalogItem && itemSearch.trim()
    ? selectedCatalogItem.supportedVariants.find((variant) =>
        variant.toLocaleLowerCase() === itemSearch.trim().toLocaleLowerCase()
      )
    : undefined;
  const effectiveSelectedVariant = searchedVariant ?? (
    selectedCatalogItem?.supportedVariants.includes(selectedVariant)
      ? selectedVariant
      : selectedCatalogItem?.supportedVariants[0] ?? "default"
  );
  const availableCharacters = useMemo(
    () => searchResults.filter(
      (candidate) => !recipients.some(
        (recipient) => recipient.playerId === candidate.playerId
      )
    ),
    [recipients, searchResults]
  );
  const recipientCount = targetMode === "all" ? eligibleCount : recipients.length;
  const recipientDataAvailable =
    catalogState === "ready" && eligibleCount !== null;
  const gemstoneCatalogItem = catalog.find((item) =>
    item.kind === "resource" && item.itemId === "enchantment_stone"
  ) ?? null;

  const refresh = (): void => {
    if (!serverHttpBase) {
      setCatalogState("error");
      setCatalogError("Character list unavailable.");
      setEligibleCount(null);
      return;
    }
    setCatalogState("loading");
    setCatalogError(null);
    setEligibleCount(null);
    void fetch(new URL(`${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`, serverHttpBase), {
      credentials: "include"
    }).then(requireJson<{
      items: PlayerPackageCatalogItem[];
      eligibleCharacterCount: number;
    }>).then((result) => {
      setCatalog(result.items);
      setEligibleCount(result.eligibleCharacterCount);
      setCatalogState("ready");
      setSelectedItemId((current) => current || result.items[0]?.itemId || "");
    }).catch((error: unknown) => {
      setCatalog([]);
      setEligibleCount(null);
      setCatalogState("error");
      setCatalogError(
        `Character list unavailable. ${errorMessage(error, "Catalog request failed.")}`
      );
    });

    setHistoryError(null);
    void fetch(new URL(`${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`, serverHttpBase), {
      credentials: "include"
    }).then(requireJson<{ campaigns: PlayerPackageCampaignSummary[] }>)
      .then((result) => setHistory(result.campaigns))
      .catch((error: unknown) => {
        setHistoryError(
          `Campaign history unavailable. ${errorMessage(error, "History request failed.")}`
        );
      });
  };

  useEffect(refresh, [serverHttpBase]);

  useEffect(() => {
    if (!recipientMenuOpen) return;
    const close = (event: MouseEvent): void => {
      if (!comboboxRef.current?.contains(event.target as Node)) {
        setRecipientMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [recipientMenuOpen]);

  useEffect(() => {
    if (
      !serverHttpBase ||
      !recipientDataAvailable ||
      targetMode !== "specific" ||
      !recipientMenuOpen
    ) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      const url = new URL(
        `${PLAYER_PACKAGE_ADMIN_API_BASE}/characters`,
        serverHttpBase
      );
      url.searchParams.set("search", recipientSearch.trim());
      url.searchParams.set(
        "limit",
        String(PLAYER_PACKAGE_LIMITS.maximumCharacterSearchResults)
      );
      void fetch(url, {
        credentials: "include",
        signal: controller.signal
      }).then(requireJson<CharacterPage>).then((result) => {
        setSearchResults(result.characters);
        setNextCursor(result.nextCursor);
        setActiveOption(result.characters.length ? 0 : -1);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSearchError(
            `Character search failed. ${errorMessage(error, "Please try again.")}`
          );
        }
      }).finally(() => {
        if (!controller.signal.aborted) setSearchLoading(false);
      });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    recipientDataAvailable,
    recipientMenuOpen,
    recipientSearch,
    serverHttpBase,
    targetMode
  ]);

  const loadMoreCharacters = async (): Promise<void> => {
    if (!serverHttpBase || !nextCursor || searchLoading) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const url = new URL(
        `${PLAYER_PACKAGE_ADMIN_API_BASE}/characters`,
        serverHttpBase
      );
      url.searchParams.set("search", recipientSearch.trim());
      url.searchParams.set("cursor", nextCursor);
      url.searchParams.set(
        "limit",
        String(PLAYER_PACKAGE_LIMITS.maximumCharacterSearchResults)
      );
      const page = await fetch(url, {
        credentials: "include"
      }).then(requireJson<CharacterPage>);
      setSearchResults((current) => uniqueCharacters([
        ...current,
        ...page.characters
      ]));
      setNextCursor(page.nextCursor);
    } catch (error) {
      setSearchError(
        `Character search failed. ${errorMessage(error, "Please try again.")}`
      );
    } finally {
      setSearchLoading(false);
    }
  };

  const selectRecipient = (
    recipient: PlayerPackageCharacterSearchResult
  ): void => {
    setRecipients((current) =>
      current.some((candidate) => candidate.playerId === recipient.playerId)
        ? current
        : [...current, recipient]
    );
    setRecipientSearch("");
    setActiveOption(0);
  };

  const addLine = (): void => {
    if (
      !selectedCatalogItem ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine
    ) {
      setFeedback("Choose an asset and a whole quantity from 1 to 10,000.");
      return;
    }
    const variant = selectedCatalogItem.assetType === "currency"
      ? null
      : effectiveSelectedVariant;
    const existing = lines.find((line) =>
      line.itemKind === selectedCatalogItem.kind &&
      line.itemId === selectedCatalogItem.itemId &&
      line.variant === variant
    );
    if (!existing && lines.length >= PLAYER_PACKAGE_LIMITS.maximumLines) {
      setFeedback("A package can contain at most 24 asset lines.");
      return;
    }
    const next: PackageLine = {
      itemKind: selectedCatalogItem.kind,
      itemId: selectedCatalogItem.itemId,
      variant,
      quantity
    };
    setLines(existing
      ? lines.map((line) => line === existing ? next : line)
      : [...lines, next]);
    setFeedback(null);
  };

  const addAllGemstones = (): void => {
    if (
      !gemstoneCatalogItem ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine ||
      !ENCHANTMENT_STONE_VARIANTS.every((variant) =>
        gemstoneCatalogItem.supportedVariants.includes(variant)
      )
    ) {
      setFeedback("The complete gemstone catalog is unavailable.");
      return;
    }
    const next = [...lines];
    for (const variant of ENCHANTMENT_STONE_VARIANTS) {
      const index = next.findIndex((line) =>
        line.itemKind === gemstoneCatalogItem.kind &&
        line.itemId === gemstoneCatalogItem.itemId &&
        line.variant === variant
      );
      const gemstoneLine: PackageLine = {
        itemKind: gemstoneCatalogItem.kind,
        itemId: gemstoneCatalogItem.itemId,
        variant,
        quantity
      };
      if (index >= 0) next[index] = gemstoneLine;
      else next.push(gemstoneLine);
    }
    if (next.length > PLAYER_PACKAGE_LIMITS.maximumLines) {
      setFeedback("Adding all gemstones would exceed the 24-line package limit.");
      return;
    }
    setLines(next);
    setFeedback(null);
  };

  const beginReview = (): void => {
    if (!recipientDataAvailable || recipientCount === null) {
      setFeedback("Character list unavailable. Reload before reviewing this package.");
      return;
    }
    const equipmentCount = lines.reduce((total, line) =>
      total + (line.itemKind === "equipment" ? line.quantity : 0), 0);
    if (!title.trim() || lines.length === 0 || recipientCount === 0) {
      setFeedback("Add recipients, a title, and at least one asset before review.");
      return;
    }
    if (equipmentCount > PLAYER_PACKAGE_LIMITS.maximumEquipmentInstances) {
      setFeedback("A package can contain at most 100 equipment instances.");
      return;
    }
    setOperationKey(crypto.randomUUID());
    setReviewing(true);
    setFeedback(null);
  };

  const send = async (): Promise<void> => {
    if (
      !serverHttpBase ||
      !csrfToken ||
      busy ||
      !recipientDataAvailable ||
      recipientCount === null ||
      (targetMode === "all" && allConfirmation !== "SEND")
    ) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(
        new URL(`${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`, serverHttpBase),
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken
          },
          body: JSON.stringify({
            operationKey,
            targetMode,
            recipientPlayerIds: targetMode === "specific"
              ? recipients.map((recipient) => recipient.playerId)
              : [],
            title: title.trim(),
            message: message.trim(),
            items: lines,
            ...(targetMode === "all"
              ? { allCharactersConfirmation: "SEND" }
              : {})
          })
        }
      );
      const result = await requireJson<{
        campaignId: string;
        recipientCount: number;
        replayed: boolean;
      }>(response);
      setFeedback(
        `Package campaign created for ${result.recipientCount.toLocaleString()} character${result.recipientCount === 1 ? "" : "s"}.`
      );
      setReviewing(false);
      setAllConfirmation("");
      setLines([]);
      refresh();
    } catch (error) {
      setFeedback(errorMessage(error, "Package campaign failed."));
    } finally {
      setBusy(false);
    }
  };

  if (reviewing) {
    return (
      <section className="developer-packages" aria-label="Review package campaign">
        <section className="developer-package-section">
          <span className="eyebrow">Review and Send</span>
          <h3>{title}</h3>
          <p>{message || "No message."}</p>
          <p>
            <strong>{recipientCount?.toLocaleString() ?? "unavailable"}</strong>
            {" "}recipient{recipientCount === 1 ? "" : "s"}:{" "}
            {targetMode === "all"
              ? "all existing characters"
              : recipients.map((recipient) => recipient.displayName).join(", ")}
          </p>
          <ul className="developer-package-review">
            {lines.map((line) => {
              const item = catalog.find(
                (candidate) =>
                  candidate.kind === line.itemKind &&
                  candidate.itemId === line.itemId
              );
              return (
                <li key={lineKey(line)}>
                  <span className={item?.assetType === "currency"
                    ? "developer-package-currency"
                    : undefined}
                  >
                    {item?.assetType === "currency" ? "Currency" : "Physical"}
                  </span>
                  <strong>
                    {line.quantity.toLocaleString()} × {packageLineDisplayName(item, line)}
                  </strong>
                </li>
              );
            })}
          </ul>
          {targetMode === "all" ? (
            <label>
              Type SEND to confirm all-character delivery
              <input
                value={allConfirmation}
                onChange={(event) => setAllConfirmation(event.currentTarget.value)}
              />
            </label>
          ) : <p>Confirm this immutable recipient list before sending.</p>}
          <div className="dev-quick-actions">
            <button type="button" onClick={() => setReviewing(false)}>Back</button>
            <button
              type="button"
              disabled={
                busy ||
                !recipientDataAvailable ||
                recipientCount === null ||
                (targetMode === "all" && allConfirmation !== "SEND")
              }
              onClick={() => void send()}
            >
              {busy
                ? "Sending…"
                : `Send to ${recipientCount?.toLocaleString() ?? "unavailable"}`}
            </button>
          </div>
          {feedback ? <p role="status" className="dev-feedback">{feedback}</p> : null}
        </section>
      </section>
    );
  }

  return (
    <section className="developer-packages" aria-label="Player Packages">
      <header>
        <h3>Player Packages</h3>
        <p className="muted">
          Create durable inbox packages. Assets are granted only when each
          character claims their own package.
        </p>
      </header>

      <section className="developer-package-section">
        <span className="eyebrow">1. Recipients</span>
        <div className="dev-form">
          <label>
            Recipients
            <select
              value={targetMode}
              onChange={(event) =>
                setTargetMode(event.currentTarget.value as "specific" | "all")}
            >
              <option value="specific">Specific characters</option>
              <option value="all" disabled={!recipientDataAvailable}>
                All existing characters ({
                  catalogState === "ready"
                    ? eligibleCount?.toLocaleString()
                    : catalogState === "loading"
                      ? "loading…"
                      : "unavailable"
                })
              </option>
            </select>
          </label>
        </div>
        {targetMode === "specific" ? (
          <>
            <div className="developer-package-combobox" ref={comboboxRef}>
              <label htmlFor="developer-package-character-search">
                Find character
              </label>
              <input
                id="developer-package-character-search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={recipientMenuOpen}
                aria-controls="developer-package-character-list"
                aria-activedescendant={
                  recipientMenuOpen && availableCharacters[activeOption]
                    ? `developer-package-character-${availableCharacters[activeOption]!.playerId}`
                    : undefined
                }
                value={recipientSearch}
                placeholder="Browse or search characters"
                disabled={!recipientDataAvailable}
                onFocus={() => setRecipientMenuOpen(true)}
                onClick={() => setRecipientMenuOpen(true)}
                onChange={(event) => {
                  setRecipientSearch(event.currentTarget.value);
                  setRecipientMenuOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRecipientMenuOpen(false);
                    return;
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setRecipientMenuOpen(true);
                    setActiveOption((current) => {
                      const maximum = availableCharacters.length - 1;
                      if (maximum < 0) return -1;
                      return event.key === "ArrowDown"
                        ? Math.min(maximum, current + 1)
                        : Math.max(0, current < 0 ? maximum : current - 1);
                    });
                    return;
                  }
                  if (
                    event.key === "Enter" &&
                    recipientMenuOpen &&
                    availableCharacters[activeOption]
                  ) {
                    event.preventDefault();
                    selectRecipient(availableCharacters[activeOption]!);
                  }
                }}
              />
              {recipientMenuOpen ? (
                <div className="developer-package-combobox-menu">
                  <ul
                    id="developer-package-character-list"
                    role="listbox"
                    aria-label="Eligible characters"
                  >
                    {availableCharacters.map((result, index) => (
                      <li
                        id={`developer-package-character-${result.playerId}`}
                        role="option"
                        aria-selected={index === activeOption}
                        key={result.playerId}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          selectRecipient(result);
                        }}
                      >
                        <strong>{result.displayName}</strong>
                        <span>{result.online ? "Online" : "Offline"}</span>
                        <small>…{result.identityHint}</small>
                      </li>
                    ))}
                  </ul>
                  {!searchLoading && availableCharacters.length === 0 ? (
                    <p className="muted">
                      {searchResults.length
                        ? "All matching characters are already selected."
                        : "No matching characters."}
                    </p>
                  ) : null}
                  {searchLoading ? <p role="status">Loading characters…</p> : null}
                  {nextCursor ? (
                    <button
                      type="button"
                      disabled={searchLoading}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void loadMoreCharacters()}
                    >
                      Load more characters
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="developer-package-chips" aria-label="Selected recipients">
              {recipients.length === 0
                ? <span className="muted">No recipients selected.</span>
                : recipients.map((recipient) => (
                    <button
                      type="button"
                      key={recipient.playerId}
                      title="Remove recipient"
                      onClick={() => setRecipients(
                        recipients.filter(
                          (candidate) => candidate.playerId !== recipient.playerId
                        )
                      )}
                    >
                      {recipient.displayName} (remove)
                    </button>
                  ))}
            </div>
          </>
        ) : null}
        {catalogError ? <p role="status" className="dev-feedback">{catalogError}</p> : null}
        {searchError ? <p role="status" className="dev-feedback">{searchError}</p> : null}
      </section>

      <section className="developer-package-section">
        <span className="eyebrow">2. Package Contents</span>
        <div className="dev-form">
          <label>
            Filter assets
            <input
              value={itemSearch}
              onChange={(event) => setItemSearch(event.currentTarget.value)}
            />
          </label>
          <label>
            Asset
            <select
              value={selectedCatalogItem?.itemId ?? ""}
              onChange={(event) => {
                setSelectedItemId(event.currentTarget.value);
                const item = catalog.find(
                  (candidate) => candidate.itemId === event.currentTarget.value
                );
                setSelectedVariant(item?.supportedVariants[0] ?? "default");
              }}
            >
              {filteredCatalog.map((item) => (
                <option key={`${item.kind}:${item.itemId}`} value={item.itemId}>
                  {item.displayName} · {item.assetType === "currency"
                    ? "currency"
                    : item.category}
                </option>
              ))}
            </select>
          </label>
          {selectedCatalogItem &&
          selectedCatalogItem.supportedVariants.length > 1 ? (
            <label>
              {selectedCatalogItem.itemId === "enchantment_stone" ? "Gemstone" : "Variant"}
              <select
                value={effectiveSelectedVariant}
                onChange={(event) => setSelectedVariant(event.currentTarget.value)}
              >
                {selectedCatalogItem.supportedVariants.map((variant) => (
                  <option key={variant} value={variant}>{humanize(variant)}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Quantity
            <input
              type="number"
              min={1}
              max={PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine}
              value={quantity}
              onChange={(event) => setQuantity(event.currentTarget.valueAsNumber)}
            />
          </label>
          <button type="button" onClick={addLine}>Add asset</button>
          {gemstoneCatalogItem ? (
            <button type="button" onClick={addAllGemstones}>
              Add all 8 gemstones
            </button>
          ) : null}
        </div>
        <div className="developer-package-lines">
          {lines.length === 0 ? <p className="muted">No package contents yet.</p> : null}
          {lines.map((line) => {
            const item = catalog.find(
              (candidate) =>
                candidate.kind === line.itemKind &&
                candidate.itemId === line.itemId
            );
            return (
              <div key={lineKey(line)}>
                <span>
                  <strong>{packageLineDisplayName(item, line)}</strong>
                  <small>{item?.assetType === "currency"
                    ? "Currency value grant"
                    : `Physical ${item?.category ?? "item"}`}
                  </small>
                </span>
                <input
                  aria-label={`Quantity for ${line.itemId}${line.variant ? `:${line.variant}` : ""}`}
                  type="number"
                  min={1}
                  max={PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine}
                  value={line.quantity}
                  onChange={(event) => setLines(lines.map((candidate) =>
                    candidate === line
                      ? { ...candidate, quantity: event.currentTarget.valueAsNumber }
                      : candidate
                  ))}
                />
                <button
                  type="button"
                  onClick={() => setLines(
                    lines.filter((candidate) => candidate !== line)
                  )}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="developer-package-section">
        <span className="eyebrow">3. Title and Message</span>
        <div className="dev-form">
          <label>
            Title
            <input
              maxLength={PLAYER_PACKAGE_LIMITS.maximumTitleLength}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            Message
            <textarea
              maxLength={PLAYER_PACKAGE_LIMITS.maximumMessageLength}
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
            />
          </label>
        </div>
      </section>

      <section className="developer-package-section">
        <span className="eyebrow">4. Review and Send</span>
        <p className="muted">
          {recipientCount?.toLocaleString() ?? "No"} recipient
          {recipientCount === 1 ? "" : "s"} · {lines.length} asset line
          {lines.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          disabled={!recipientDataAvailable}
          onClick={beginReview}
        >
          Review and send
        </button>
        {feedback ? <p role="status" className="dev-feedback">{feedback}</p> : null}
      </section>

      <section className="developer-package-section">
        <span className="eyebrow">5. Recent Campaigns</span>
        {historyError ? <p role="status" className="dev-feedback">{historyError}</p> : null}
        <div className="developer-package-history">
          {history.length === 0 && !historyError
            ? <p className="muted">No package campaigns yet.</p>
            : history.map((campaign) => (
                <article key={campaign.campaignId}>
                  <strong>{campaign.title}</strong>
                  <span>
                    {campaign.recipientCount.toLocaleString()} recipients ·{" "}
                    {campaign.unopenedCount} unopened · {campaign.partialCount} partial ·{" "}
                    {campaign.claimedCount} claimed
                  </span>
                </article>
              ))}
        </div>
      </section>
    </section>
  );
}

function lineKey(line: PackageLine): string {
  return `${line.itemKind}:${line.itemId}:${line.variant ?? "none"}`;
}

function packageLineDisplayName(
  item: PlayerPackageCatalogItem | undefined,
  line: PackageLine
): string {
  if (line.itemId === "enchantment_stone" && line.variant) {
    return `${humanize(line.variant)} Enchantment Stone`;
  }
  return item?.displayName ?? line.itemId;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function uniqueCharacters(
  characters: readonly PlayerPackageCharacterSearchResult[]
): PlayerPackageCharacterSearchResult[] {
  return [...new Map(
    characters.map((character) => [character.playerId, character])
  ).values()];
}

async function requireJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    message?: string;
  } & T;
  if (!response.ok) {
    throw new Error(
      body.error?.message ?? body.message ?? `Request failed (${response.status})`
    );
  }
  return body;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
