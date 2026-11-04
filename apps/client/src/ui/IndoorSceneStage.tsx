import type { ComponentPropsWithoutRef, CSSProperties, ReactNode, Ref } from "react";

type IndoorSceneStageProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "className" | "style"
> & {
  roomWidth: number;
  roomHeight: number;
  innerClassName: string;
  frameClassName?: string;
  scale?: number;
  translation?: Readonly<{ x: number; y: number }>;
  stageStyle?: CSSProperties;
  stageRef: Ref<HTMLDivElement>;
  children: ReactNode;
};

export function IndoorSceneStage({
  roomWidth,
  roomHeight,
  innerClassName,
  frameClassName,
  scale,
  translation,
  stageStyle,
  stageRef,
  children,
  ...stageProps
}: IndoorSceneStageProps): React.JSX.Element {
  if (!Number.isFinite(roomWidth) || roomWidth <= 0 ||
      !Number.isFinite(roomHeight) || roomHeight <= 0) {
    throw new RangeError("Indoor scene dimensions must be positive finite numbers.");
  }
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
    throw new RangeError("Indoor scene scale must be a positive finite number.");
  }
  if (translation !== undefined &&
      (!Number.isFinite(translation.x) || !Number.isFinite(translation.y))) {
    throw new RangeError("Indoor scene translation must be finite.");
  }
  const fitWidthFromHeight = roomWidth / roomHeight * 100;
  const transform = scale === undefined && translation === undefined
    ? undefined
    : `${translation ? `translate(${translation.x}px, ${translation.y}px)` : ""}${scale === undefined ? "" : `${translation ? " " : ""}scale(${scale})`}`;
  return <div className={`indoor-scene-stage-frame${frameClassName ? ` ${frameClassName}` : ""}`}>
      <div
        {...stageProps}
        ref={stageRef}
        className={`indoor-scene-stage ${innerClassName}`}
        data-indoor-view="fit"
        data-indoor-scale={scale}
        style={{
          ...stageStyle,
          aspectRatio: `${roomWidth} / ${roomHeight}`,
          width: `min(100cqw, ${fitWidthFromHeight}cqh)`,
          ...(transform === undefined ? {} : {
            transform,
            transformOrigin: "center center"
          })
        }}
      >
        {children}
      </div>
  </div>;
}
