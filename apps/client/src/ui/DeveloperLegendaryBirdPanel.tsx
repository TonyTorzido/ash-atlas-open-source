import { useEffect, useState } from "react";

type Player = { playerId: string; playerName: string; eligibleBastionFlagCount: number };
type Species = "random" | "fire" | "lightning" | "ice";

export function DeveloperLegendaryBirdPanel({ serverHttpBase, csrfToken }: Readonly<{
  serverHttpBase: string;
  csrfToken?: string;
}>): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Player | null>(null);
  const [species, setSpecies] = useState<Species>("random");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (!search.trim()) { setPlayers([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const url = new URL("/api/dev/legendary-birds/players", serverHttpBase);
      url.searchParams.set("search", search);
      void fetch(url, { credentials: "include", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Player search failed");
          return response.json() as Promise<{ players: Player[] }>;
        })
        .then((result) => setPlayers(result.players))
        .catch((error: unknown) => { if (!controller.signal.aborted) setFeedback(error instanceof Error ? error.message : "Player search failed"); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, serverHttpBase]);
  const trigger = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true); setFeedback(null);
    try {
      const response = await fetch(new URL("/api/dev/legendary-birds/trigger", serverHttpBase), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        body: JSON.stringify({ playerId: selected.playerId, ...(species === "random" ? {} : { birdSpecies: species }), operationKey: crypto.randomUUID() })
      });
      const result = await response.json() as { playerName?: string; birdSpecies?: string; replayed?: boolean; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Legendary bird trigger failed");
      const label = { fire: "Phoenix", lightning: "Thunderbird", ice: "Ice Phoenix" }[result.birdSpecies ?? ""] ?? "Legendary bird";
      setFeedback(`${label} triggered for ${result.playerName ?? selected.playerName}.`);
    } catch (error) { setFeedback(error instanceof Error ? error.message : "Legendary bird trigger failed"); }
    finally { setBusy(false); }
  };
  return <section aria-label="Legendary bird events">
    <h3>Legendary Bird Event</h3>
    <div className="dev-form">
      <label>Player search<input value={search} onChange={(event) => { setSearch(event.currentTarget.value); setSelected(null); }} /></label>
      <label>Species<select value={species} onChange={(event) => setSpecies(event.currentTarget.value as Species)}><option value="random">Random</option><option value="fire">Phoenix</option><option value="lightning">Thunderbird</option><option value="ice">Ice Phoenix</option></select></label>
      <button type="button" disabled={!selected || selected.eligibleBastionFlagCount < 1 || busy} onClick={() => void trigger()}>{busy ? "Triggering…" : "Trigger Event"}</button>
    </div>
    {players.map((player) => <button type="button" key={player.playerId} className={selected?.playerId === player.playerId ? "active" : undefined} onClick={() => setSelected(player)}>{player.playerName} · {player.eligibleBastionFlagCount} available bastion flag{player.eligibleBastionFlagCount === 1 ? "" : "s"}</button>)}
    {feedback ? <p role="status" className="dev-feedback">{feedback}</p> : null}
  </section>;
}
