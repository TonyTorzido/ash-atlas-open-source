type AshAtlasBrandLogoProps = {
  className?: string;
};

export function AshAtlasBrandLogo({ className }: AshAtlasBrandLogoProps): React.JSX.Element {
  return (
    <img
      className={className}
      src={`${import.meta.env.BASE_URL}icon-192x192.png`}
      alt=""
      aria-hidden="true"
    />
  );
}
