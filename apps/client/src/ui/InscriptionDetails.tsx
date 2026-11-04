import { inscriptionStatRows, type InscriptionSnapshot } from "@ash-atlas/shared";

/** The inscribed name, who inscribed it, and the counters kept on the item. */
export function InscriptionDetails({ inscription }: Readonly<{
  inscription: InscriptionSnapshot | null | undefined;
}>): React.JSX.Element | null {
  if (!inscription) return null;
  return <section className="inscription-details" aria-label="Inscription">
    <strong>{inscription.name}</strong>
    <small>Inscribed by {inscription.inscriberName}</small>
    <dl className="game-app-stats">
      {inscriptionStatRows(inscription).map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  </section>;
}

