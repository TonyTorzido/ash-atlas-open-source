export function IndoorSceneViewport({
  className,
  ariaLabel,
  children
}: {
  className: string;
  ariaLabel: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <section className={`indoor-scene-viewport ${className}`} aria-label={ariaLabel}>
    {children}
  </section>;
}
