export type DevConsoleCommand =
  | { type: "help" }
  | { type: "clear" }
  | { type: "flags-clear" }
  | { type: "flags-count" }
  | { type: "spawns-count" }
  | { type: "resources-vision" }
  | { type: "player-where" }
  | { type: "perf" }
  | { type: "perf-reset" }
  | { type: "perf-record-start" }
  | { type: "perf-record-stop" }
  | { type: "perf-record-status" }
  | { type: "perf-record-reset" }
  | { type: "movement-trace-on" }
  | { type: "movement-trace-off" }
  | { type: "movement-trace-status" }
  | { type: "movement-trace-clear" }
  | { type: "movement-trace-copy" }
  | { type: "teleport"; lat: number; lon: number }
  | { type: "unknown"; raw: string };

export function parseDevConsoleCommand(rawCommand: string): DevConsoleCommand {
  const command = rawCommand.trim();
  if (command === "help") {
    return { type: "help" };
  }
  if (command === "clear") {
    return { type: "clear" };
  }
  if (command === "flags clear") {
    return { type: "flags-clear" };
  }
  if (command === "flags count") {
    return { type: "flags-count" };
  }
  if (
    command === "spawns count" ||
    command === "collectibles count" ||
    command === "nodes count"
  ) {
    return { type: "spawns-count" };
  }
  if (command === "resources vision" || command === "resource vision") {
    return { type: "resources-vision" };
  }
  if (command === "player where") {
    return { type: "player-where" };
  }
  if (command === "perf") {
    return { type: "perf" };
  }
  if (command === "perf reset") {
    return { type: "perf-reset" };
  }
  if (command === "perf record start" || command === "record start") {
    return { type: "perf-record-start" };
  }
  if (command === "perf record stop" || command === "record stop") {
    return { type: "perf-record-stop" };
  }
  if (command === "perf record status" || command === "record status") {
    return { type: "perf-record-status" };
  }
  if (command === "perf record reset" || command === "record reset") {
    return { type: "perf-record-reset" };
  }
  if (command === "movement trace on") {
    return { type: "movement-trace-on" };
  }
  if (command === "movement trace off") {
    return { type: "movement-trace-off" };
  }
  if (command === "movement trace status") {
    return { type: "movement-trace-status" };
  }
  if (command === "movement trace clear") {
    return { type: "movement-trace-clear" };
  }
  if (command === "movement trace copy") {
    return { type: "movement-trace-copy" };
  }

  const teleport = parseTeleportCommand(command);
  if (teleport) {
    return teleport;
  }

  return { type: "unknown", raw: command };
}

function parseTeleportCommand(command: string): DevConsoleCommand | null {
  const match = /^(?:tp|teleport)\s+(.+)$/i.exec(command);
  if (!match?.[1]) {
    return null;
  }
  const parts = match[1].includes(",")
    ? match[1].split(",").map((part) => part.trim())
    : match[1].trim().split(/\s+/);
  if (parts.length !== 2) {
    return { type: "unknown", raw: command };
  }
  const [rawLat, rawLon] = parts;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { type: "unknown", raw: command };
  }
  return { type: "teleport", lat, lon };
}
