import type { HTMLAttributes, ReactNode } from "react";

type Props = Readonly<{
  title?: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  tone?: "incoming" | "outgoing" | "neutral";
  compact?: boolean;
  children: ReactNode;
}> & Omit<HTMLAttributes<HTMLElement>, "title">;

export function GameMessageBox({
  title,
  meta,
  footer,
  tone = "neutral",
  compact = false,
  className,
  children,
  ...articleProps
}: Props): React.JSX.Element {
  return <article
    {...articleProps}
    className={[
      "game-message-box",
      `game-message-box--${tone}`,
      compact ? "game-message-box--compact" : "",
      className ?? ""
    ].filter(Boolean).join(" ")}
  >
    {title || meta ? <header>
      {title ? <h3>{title}</h3> : null}
      {meta ? <span>{meta}</span> : null}
    </header> : null}
    <div className="game-message-box__content">{children}</div>
    {footer ? <footer>{footer}</footer> : null}
  </article>;
}
