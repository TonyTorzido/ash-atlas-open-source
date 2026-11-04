import type { IndoorPoint } from "@ash-atlas/shared";

import {
  MIN_POLYGON_VERTICES,
  type MutablePoint,
  insertVertexAfter,
  parseUvPolygon,
  removeVertexAt,
  type UvPoint,
  type WallImageTransform
} from "./interiorCanvasAuthoring.js";

/** Form controls shared by the Manor inspector and the Interior Studio shape inspector. */

export function DebugToggle(props: { label: string; checked: boolean; onChange(): void }): React.JSX.Element {
  return <label className="toggle"><input type="checkbox" checked={props.checked} onChange={props.onChange} /><span>{props.label}</span></label>;
}

export function NumberField(props: { label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean | undefined; unit?: string; help?: string; onChange(value: number): void }): React.JSX.Element {
  const input = <input type="number" value={Number.isFinite(props.value) ? props.value : 0} min={props.min} max={props.max} step={props.step ?? 1} disabled={props.disabled} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) props.onChange(value); }} />;
  return <label className="field compact" title={props.help} {...(props.help ? { "data-help": props.help } : {})}><span>{props.label}</span>{props.unit ? <span className="field-input" data-unit={props.unit}>{input}</span> : input}</label>;
}

/** Wall image mapping: offset/scale/rotation plus the normalized image polygon. */
export function WallMappingFields(props: {
  title: string;
  idKey: string;
  transform: WallImageTransform;
  imagePolygon: readonly UvPoint[];
  disabled?: boolean | undefined;
  onTransform(key: keyof WallImageTransform, value: number): void;
  onImagePolygon(value: UvPoint[]): void;
}): React.JSX.Element {
  const field = (label: string, key: keyof WallImageTransform, step: number): React.JSX.Element =>
    <NumberField label={label} value={props.transform[key]} step={step} disabled={props.disabled} onChange={(value) => props.onTransform(key, value)} />;
  return <>
    <p className="manor-inspector-section">{props.title}</p>
    <div className="field-grid">
      {field("Offset U", "offsetU", 0.01)}
      {field("Offset V", "offsetV", 0.01)}
      {field("Scale U", "scaleU", 0.01)}
      {field("Scale V", "scaleV", 0.01)}
      {field("Rotation°", "rotationDeg", 1)}
    </div>
    <label className="field compact"><span>Image polygon (normalized u/v JSON)</span><textarea key={`image:${props.idKey}`} defaultValue={JSON.stringify(props.imagePolygon)} disabled={props.disabled} onBlur={(event) => { const parsed = parseUvPolygon(event.currentTarget.value); if (parsed) props.onImagePolygon(parsed); }} /></label>
  </>;
}

/** Connected-vertex list for one polygon: edit X/Y, add a vertex after another, remove (at least three stay). */
export function VertexListEditor(props: {
  points: readonly IndoorPoint[];
  disabled?: boolean | undefined;
  selectedIndex?: number | null;
  onSelect?(index: number): void;
  onChange(points: MutablePoint[]): void;
}): React.JSX.Element {
  const update = (edit: (points: MutablePoint[]) => void): void => {
    const next: MutablePoint[] = props.points.map((point) => ({ x: point.x, y: point.y }));
    edit(next);
    props.onChange(next);
  };
  return <div className="vertex-list" role="group" aria-label="Polygon vertices">
    <p>{props.points.length} connected vertices · simple polygon</p>
    {props.points.map((point, index) => <div className={`vertex-row field-grid ${props.selectedIndex === index ? "selected" : ""}`} key={index} onFocus={() => props.onSelect?.(index)}>
      <NumberField label={`Vertex ${index + 1} X`} unit="px" value={point.x} disabled={props.disabled} onChange={(x) => update((next) => { next[index]!.x = x; })} />
      <NumberField label={`Vertex ${index + 1} Y`} unit="px" value={point.y} disabled={props.disabled} onChange={(y) => update((next) => { next[index]!.y = y; })} />
      <button type="button" aria-label={`Add vertex after ${index + 1}`} disabled={props.disabled} onClick={() => update((next) => { insertVertexAfter(next, index); })}>+</button>
      <button type="button" aria-label={`Remove vertex ${index + 1}`} disabled={props.disabled || props.points.length <= MIN_POLYGON_VERTICES} onClick={() => update((next) => { removeVertexAt(next, index); })}>−</button>
    </div>)}
  </div>;
}
