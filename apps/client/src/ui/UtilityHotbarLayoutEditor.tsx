import {
  HOTBAR_DEFAULT_LAYOUT_GEOMETRY,
  HOTBAR_DEFAULT_ROW_POSITIONS,
  HOTBAR_MAX_VISIBLE_ROWS,
  HOTBAR_ROW_POSITION_MAX,
  HOTBAR_ROW_POSITION_MIN,
  HOTBAR_ROW_VISUAL_GAP_PX,
  fitHotbarLayoutGeometry,
  hotbarRowAnchorConstraints,
  normalizeHotbarRowPositions,
  type HotbarLayoutGeometry
} from "@ash-atlas/shared";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react";

import { useModalBehavior } from "./useModalBehavior.js";

type Rect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

type MeasuredTrack = Readonly<{
  track: Rect;
  rows: readonly Rect[];
  geometry: HotbarLayoutGeometry;
  /** Viewport origin of the fixed editor's containing block. */
  origin: Readonly<{ left: number; top: number }>;
}>;

export type UtilityHotbarLayoutEditorProps = Readonly<{
  rowCount: number;
  /** Persisted anchors expressed as percentages of the measured gameplay track. */
  rowPositions: readonly number[];
  trackRef: RefObject<HTMLElement | null>;
  geometry?: HotbarLayoutGeometry | null;
  onLayoutChange(nextPositions: readonly number[]): void;
  onDone(): void;
  onCancel(): void;
}>;

const safeRowCount = (value: number): number => Math.min(
  HOTBAR_MAX_VISIBLE_ROWS,
  Math.max(0, Number.isFinite(value) ? Math.trunc(value) : 0)
);

/**
 * In-context utility row editor. It is rendered above the real gameplay
 * hotbar, so handles and highlighted rows follow the measured tile footprint
 * instead of a synthetic menu preview.
 */
export function UtilityHotbarLayoutEditor({
  rowCount,
  rowPositions,
  trackRef,
  geometry,
  onLayoutChange,
  onDone,
  onCancel
}: UtilityHotbarLayoutEditorProps): React.JSX.Element {
  const safeCount = safeRowCount(rowCount);
  const closedRef = useRef(false);
  const closeOnce = (callback: () => void): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    callback();
  };
  const handleDone = (): void => closeOnce(onDone);
  const handleCancel = (): void => closeOnce(onCancel);
  const editorRef = useModalBehavior<HTMLElement>({
    open: true,
    onClose: handleCancel,
    initialFocus: "first"
  });
  const dragRowRef = useRef<number | null>(null);
  const dragPointerRef = useRef<number | null>(null);
  const dragOffsetRef = useRef(0);
  const [measurement, setMeasurement] = useState<MeasuredTrack | null>(null);

  const measure = useCallback((): void => {
    const track = trackRef.current;
    if (!track) {
      setMeasurement(null);
      return;
    }
    const trackMeasurement = toRect(track.getBoundingClientRect());
    if (!trackMeasurement || trackMeasurement.height <= 0 || trackMeasurement.width <= 0) {
      setMeasurement(null);
      return;
    }
    const editorMeasurement = toRect(editorRef.current?.getBoundingClientRect());
    const origin = {
      left: editorMeasurement?.left ?? 0,
      top: editorMeasurement?.top ?? 0
    };

    const firstRow = track.querySelector<HTMLElement>("[data-hotbar-row='1']");
    const measuredRowHeight = firstRow?.getBoundingClientRect().height
      || track.querySelector<HTMLElement>(".ash-hotbar-slot")?.getBoundingClientRect().height
      || 0;
    const rowHeight = measuredRowHeight > 0
      ? measuredRowHeight
      : geometry?.rowHeight && geometry.rowHeight > 0
        ? geometry.rowHeight
        : HOTBAR_DEFAULT_LAYOUT_GEOMETRY.rowHeight;
    const measuredGeometry = fitHotbarLayoutGeometry({
      trackHeight: trackMeasurement.height,
      rowHeight,
      rowGap: geometry?.rowGap ?? HOTBAR_ROW_VISUAL_GAP_PX
    }, safeCount);
    const displayedPositions = normalizeHotbarRowPositions(safeCount, rowPositions, measuredGeometry);
    const rows = Array.from({ length: safeCount }, (_, row) => {
      const leftRow = track.querySelector<HTMLElement>(`.ash-hotbar-rail-left [data-hotbar-row='${row + 1}']`);
      const rightRow = track.querySelector<HTMLElement>(`.ash-hotbar-rail-right [data-hotbar-row='${row + 1}']`);
      const left = leftRow?.querySelector<HTMLElement>(".ash-hotbar-slot") ?? leftRow;
      const right = rightRow?.querySelector<HTMLElement>(".ash-hotbar-slot") ?? rightRow;
      const leftRect = left ? toRect(left.getBoundingClientRect()) : null;
      const rightRect = right ? toRect(right.getBoundingClientRect()) : null;
      const leftRowRect = leftRow ? toRect(leftRow.getBoundingClientRect()) : null;
      const rightRowRect = rightRow ? toRect(rightRow.getBoundingClientRect()) : null;
      const top = Math.min(
        leftRowRect?.top ?? leftRect?.top ?? Number.POSITIVE_INFINITY,
        rightRowRect?.top ?? rightRect?.top ?? Number.POSITIVE_INFINITY
      );
      const bottom = Math.max(
        leftRowRect ? leftRowRect.top + leftRowRect.height : leftRect ? leftRect.top + leftRect.height : 0,
        rightRowRect ? rightRowRect.top + rightRowRect.height : rightRect ? rightRect.top + rightRect.height : 0
      );
      if (Number.isFinite(top) && bottom > top) {
        return {
          // The editor handle represents the whole usable gameplay track,
          // not just the gap between the two side rails. Keep the measured
          // row footprint for height and vertical alignment below.
          left: trackMeasurement.left,
          top,
          width: trackMeasurement.width,
          height: bottom - top
        };
      }
      const fallbackTop = trackMeasurement.top + ((displayedPositions[row] ?? 0) / 100) * trackMeasurement.height;
      return {
        left: trackMeasurement.left,
        top: fallbackTop,
        width: trackMeasurement.width,
        height: measuredGeometry.rowHeight
      };
    });
    const nextMeasurement = { track: trackMeasurement, rows, geometry: measuredGeometry, origin };
    setMeasurement((current) => sameMeasurement(current, nextMeasurement) ? current : nextMeasurement);
  }, [geometry, rowPositions, safeCount, trackRef]);

  useLayoutEffect(() => {
    measure();
    const track = trackRef.current;
    if (!track) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(track);
    track.querySelectorAll<HTMLElement>(".ash-hotbar-row, .ash-hotbar-slot").forEach((element) => observer?.observe(element));
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    const frame = window.requestAnimationFrame(measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [measure, trackRef]);

  const effectiveGeometry = measurement?.geometry ?? geometry ?? HOTBAR_DEFAULT_LAYOUT_GEOMETRY;
  const constraints = useMemo(
    () => hotbarRowAnchorConstraints(effectiveGeometry, safeCount),
    [effectiveGeometry, safeCount]
  );
  const displayedPositions = useMemo(
    () => normalizeHotbarRowPositions(safeCount, rowPositions, effectiveGeometry),
    [effectiveGeometry, rowPositions, safeCount]
  );
  const persistedDisplayedPositions = useMemo(
    () => persistedRowPositionsForGeometry(displayedPositions, safeCount, effectiveGeometry, constraints.maxAnchor),
    [constraints.maxAnchor, displayedPositions, effectiveGeometry, safeCount]
  );

  const updateRowFromDisplayAnchor = useCallback((row: number, displayAnchor: number): void => {
    const nextDisplayed = normalizeDisplayedRowPositionUpdate(
      safeCount,
      displayedPositions,
      row,
      displayAnchor,
      constraints
    );
    const nextPersisted = persistedRowPositionsForGeometry(nextDisplayed, safeCount, effectiveGeometry, constraints.maxAnchor);
    if (nextPersisted.every((position, index) => position === rowPositions[index])) return;
    onLayoutChange(nextPersisted);
  }, [constraints.maxAnchor, effectiveGeometry, onLayoutChange, rowPositions, safeCount]);

  const updateRowFromPointer = useCallback((row: number, clientY: number): void => {
    const track = trackRef.current;
    const trackRect = track?.getBoundingClientRect();
    if (!trackRect || trackRect.height <= 0 || !Number.isFinite(clientY)) return;
    const displayAnchor = Math.min(
      constraints.maxAnchor,
      Math.max(0, ((clientY - dragOffsetRef.current - trackRect.top) / trackRect.height) * 100)
    );
    updateRowFromDisplayAnchor(row, displayAnchor);
  }, [constraints.maxAnchor, trackRef, updateRowFromDisplayAnchor]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, row: number): void => {
    event.preventDefault();
    event.stopPropagation();
    dragRowRef.current = row;
    dragPointerRef.current = event.pointerId;
    dragOffsetRef.current = Math.max(0, (event.clientY - (measurement?.rows[row]?.top ?? event.clientY)));
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateRowFromPointer(row, event.clientY);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>, row: number): void => {
    event.preventDefault();
    event.stopPropagation();
    if (dragRowRef.current !== row || dragPointerRef.current !== event.pointerId) return;
    updateRowFromPointer(row, event.clientY);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (dragPointerRef.current === event.pointerId) {
      dragRowRef.current = null;
      dragPointerRef.current = null;
      dragOffsetRef.current = 0;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, row: number): void => {
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = displayedPositions[row] ?? 0;
    const delta = event.key === "ArrowUp" ? -1
      : event.key === "ArrowDown" ? 1
        : event.key === "PageUp" ? -10
          : event.key === "PageDown" ? 10
            : event.key === "Home" ? -current
              : constraints.maxAnchor - current;
    updateRowFromDisplayAnchor(row, current + delta);
  };

  return (
    <section
      ref={editorRef}
      className="ash-hotbar-layout-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ash-hotbar-layout-editor-title"
      tabIndex={-1}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="ash-hotbar-layout-editor-scrim" aria-hidden="true" />
      <div className="ash-hotbar-layout-editor-panel">
        <span className="ash-hotbar-layout-editor-eyebrow">UTILITY HOTBAR</span>
        <h2 id="ash-hotbar-layout-editor-title">Adjust Slots</h2>
        <p>Drag a paired row up or down. Focus a row and use the arrow keys.</p>
        <div className="ash-hotbar-layout-editor-actions">
          <button type="button" className="game-app-button game-app-button-primary" onClick={(event) => {
            event.stopPropagation();
            // The controls are positioned from the same measured rows that
            // render in the gameplay hotbar. Commit that measured, normalized
            // draft before closing so Accept cannot reintroduce stale or
            // geometry-invalid anchors.
            if (measurement && !sameRowPositions(persistedDisplayedPositions, rowPositions)) {
              onLayoutChange(persistedDisplayedPositions);
            }
            handleDone();
          }}>Accept</button>
          <button type="button" className="game-app-button game-app-button-quiet" onClick={(event) => {
            event.stopPropagation();
            handleCancel();
          }}>Cancel</button>
        </div>
      </div>
      <div className="ash-hotbar-layout-editor-rows" aria-label="Utility hotbar rows">
        {measurement ? Array.from({ length: safeCount }, (_, row) => {
          const position = displayedPositions[row] ?? 0;
          const rect = measurement.rows[row];
          const style = rect ? {
            "--ash-hotbar-edit-left": `${rect.left - measurement.origin.left}px`,
            "--ash-hotbar-edit-top": `${rect.top - measurement.origin.top}px`,
            "--ash-hotbar-edit-width": `${rect.width}px`,
            "--ash-hotbar-edit-height": `${rect.height}px`
          } as CSSProperties : undefined;
          return (
            <div
              key={row}
              className="ash-hotbar-layout-editor-row"
              role="slider"
              tabIndex={0}
              aria-label={`Move Row ${row + 1} vertically`}
              aria-valuemin={0}
              aria-valuemax={Math.round(constraints.maxAnchor * 100) / 100}
              aria-valuenow={Math.round(position * 100) / 100}
              aria-valuetext={`${Math.round(position)}% from top`}
              data-hotbar-edit-row={row + 1}
              style={style}
              onPointerDown={(event) => beginDrag(event, row)}
              onPointerMove={(event) => moveDrag(event, row)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={(event) => onRowKeyDown(event, row)}
            >
              <span>Row {row + 1}</span>
              <output>{Math.round(position)}%</output>
            </div>
          );
        }) : null}
      </div>
    </section>
  );
}

function normalizeDisplayedRowPositionUpdate(
  rowCount: number,
  displayedPositions: readonly number[],
  rowIndex: number,
  value: number,
  constraints: Readonly<{ maxAnchor: number; minAnchorGap: number }>
): number[] {
  const count = safeRowCount(rowCount);
  const maxAnchor = Math.min(
    HOTBAR_ROW_POSITION_MAX,
    Math.max(HOTBAR_ROW_POSITION_MIN, constraints.maxAnchor)
  );
  const gap = Math.max(0, constraints.minAnchorGap);
  const next = HOTBAR_DEFAULT_ROW_POSITIONS.map((fallback, index) => {
    const position = displayedPositions[index] ?? fallback;
    return Math.min(HOTBAR_ROW_POSITION_MAX, Math.max(HOTBAR_ROW_POSITION_MIN, Number.isFinite(position) ? position : fallback));
  });
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= count) return next;
  const minimum = Math.min(maxAnchor, rowIndex * gap);
  const maximum = Math.max(minimum, maxAnchor - gap * (count - 1 - rowIndex));
  next[rowIndex] = Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : next[rowIndex]!));
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    next[index] = Math.min(next[index]!, next[index + 1]! - gap);
  }
  for (let index = rowIndex + 1; index < count; index += 1) {
    next[index] = Math.min(maxAnchor, Math.max(next[index]!, next[index - 1]! + gap));
  }
  return next.map((position, index) => Math.round(Math.min(
    index < count ? maxAnchor : HOTBAR_ROW_POSITION_MAX,
    Math.max(HOTBAR_ROW_POSITION_MIN, position)
  ) * 100) / 100);
}

function persistedRowPositionsForGeometry(
  displayedPositions: readonly number[],
  rowCount: number,
  geometry: HotbarLayoutGeometry,
  maxAnchor: number
): number[] {
  const count = safeRowCount(rowCount);
  const compactScale = geometry.compactTrackHeight === undefined ? 1 : maxAnchor / 100;
  return HOTBAR_DEFAULT_ROW_POSITIONS.map((fallback, index) => {
    const position = displayedPositions[index] ?? fallback;
    if (index >= count || compactScale >= 1 || compactScale <= 0) return position;
    return Math.round(Math.min(HOTBAR_ROW_POSITION_MAX, Math.max(HOTBAR_ROW_POSITION_MIN, position / compactScale)) * 100) / 100;
  });
}

function sameRowPositions(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((position, index) => position === right[index]);
}

function toRect(rect: DOMRect | undefined): Rect | null {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function sameRect(left: Rect | undefined, right: Rect | undefined): boolean {
  return left?.left === right?.left && left?.top === right?.top && left?.width === right?.width && left?.height === right?.height;
}

function sameMeasurement(left: MeasuredTrack | null, right: MeasuredTrack): boolean {
  if (!left || !sameRect(left.track, right.track) || left.rows.length !== right.rows.length) return false;
  return left.rows.every((row, index) => sameRect(row, right.rows[index])) &&
    left.origin.left === right.origin.left &&
    left.origin.top === right.origin.top &&
    left.geometry.trackHeight === right.geometry.trackHeight &&
    left.geometry.rowHeight === right.geometry.rowHeight &&
    left.geometry.rowGap === right.geometry.rowGap &&
    left.geometry.compactTrackHeight === right.geometry.compactTrackHeight;
}
