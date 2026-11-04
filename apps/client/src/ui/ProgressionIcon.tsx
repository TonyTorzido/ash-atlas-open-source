import { progressionIconTransformCss } from "@ash-atlas/shared";
import type { CSSProperties } from "react";

import "./ProgressionIcon.css";

export type ProgressionSpriteSource = Readonly<{
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  key?: string;
  offsetX?: number;
  offsetY?: number;
  scale?: number;
}>;

export type ProgressionIconProps = Readonly<{
  alt: string;
  size?: number;
  src?: string;
  sprite?: ProgressionSpriteSource;
  iconKey?: string;
  className?: string;
}>;

export function ProgressionIcon({
  alt,
  size = 48,
  src,
  sprite,
  iconKey,
  className,
}: ProgressionIconProps): React.JSX.Element {
  const classes = `progression-icon${className ? ` ${className}` : ""}`;
  const frameStyle = {
    "--progression-icon-size": `${size}px`,
  } as CSSProperties;
  const resolvedIconKey = iconKey ?? sprite?.key;

  if (src) {
    return (
      <span
        className={classes}
        style={frameStyle}
        data-icon-key={resolvedIconKey}
      >
        <img src={src} alt={alt} width={size} height={size} />
      </span>
    );
  }
  if (sprite) {
    const transform = {
      offsetX: sprite.offsetX ?? 0,
      offsetY: sprite.offsetY ?? 0,
      scale: sprite.scale ?? 1
    };
    const spriteStyle = {
      position: "absolute",
      left: "50%",
      top: "50%",
      marginLeft: -sprite.width / 2,
      marginTop: -sprite.height / 2,
      width: sprite.width,
      height: sprite.height,
      backgroundImage: `url(${JSON.stringify(sprite.src)})`,
      backgroundPosition: `${-sprite.x}px ${-sprite.y}px`,
      transform: progressionIconTransformCss(transform, size, Math.max(sprite.width, sprite.height)),
      transformOrigin: "center",
    } as CSSProperties;
    return (
      <span
        className={`${classes} progression-icon-sprite`}
        style={frameStyle}
        role="img"
        aria-label={alt}
        data-icon-key={resolvedIconKey}
        data-sprite-key={sprite.key}
      >
        <span aria-hidden="true" style={spriteStyle} />
      </span>
    );
  }
  return (
    <span
      className={`${classes} progression-icon-fallback`}
      style={frameStyle}
      role="img"
      aria-label={alt}
      data-icon-key={resolvedIconKey}
    >
      <span aria-hidden="true">{fallbackInitials(resolvedIconKey ?? alt)}</span>
    </span>
  );
}

function fallbackInitials(value: string): string {
  const words = value
    .replace(/\bicon\b/giu, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length > 1) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}
