import { describe, expect, it } from "vitest";

import { parseDevConsoleCommand } from "./devConsoleCommands.js";

describe("dev console command parsing", () => {
  it("parses teleport commands with space separated coordinates", () => {
    expect(parseDevConsoleCommand("tp 35.0843 -106.6205")).toEqual({
      type: "teleport",
      lat: 35.0843,
      lon: -106.6205
    });
    expect(parseDevConsoleCommand("teleport 35.0843 -106.6205")).toEqual({
      type: "teleport",
      lat: 35.0843,
      lon: -106.6205
    });
  });

  it("parses teleport commands with comma separated coordinates", () => {
    expect(parseDevConsoleCommand("tp 35.0843,-106.6205")).toEqual({
      type: "teleport",
      lat: 35.0843,
      lon: -106.6205
    });
  });

  it("rejects malformed teleport commands", () => {
    expect(parseDevConsoleCommand("tp nowhere")).toEqual({
      type: "unknown",
      raw: "tp nowhere"
    });
    expect(parseDevConsoleCommand("tp 35 -106 extra")).toEqual({
      type: "unknown",
      raw: "tp 35 -106 extra"
    });
  });

  it("parses performance commands", () => {
    expect(parseDevConsoleCommand("perf")).toEqual({
      type: "perf"
    });
    expect(parseDevConsoleCommand("perf reset")).toEqual({
      type: "perf-reset"
    });
    expect(parseDevConsoleCommand("perf record start")).toEqual({
      type: "perf-record-start"
    });
    expect(parseDevConsoleCommand("perf record stop")).toEqual({
      type: "perf-record-stop"
    });
    expect(parseDevConsoleCommand("perf record status")).toEqual({
      type: "perf-record-status"
    });
    expect(parseDevConsoleCommand("perf record reset")).toEqual({
      type: "perf-record-reset"
    });
    expect(parseDevConsoleCommand("record start")).toEqual({
      type: "perf-record-start"
    });
    expect(parseDevConsoleCommand("record stop")).toEqual({
      type: "perf-record-stop"
    });
    expect(parseDevConsoleCommand("record status")).toEqual({
      type: "perf-record-status"
    });
    expect(parseDevConsoleCommand("record reset")).toEqual({
      type: "perf-record-reset"
    });
  });

  it("parses movement trace commands", () => {
    expect(parseDevConsoleCommand("movement trace on")).toEqual({
      type: "movement-trace-on"
    });
    expect(parseDevConsoleCommand("movement trace off")).toEqual({
      type: "movement-trace-off"
    });
    expect(parseDevConsoleCommand("movement trace status")).toEqual({
      type: "movement-trace-status"
    });
    expect(parseDevConsoleCommand("movement trace clear")).toEqual({
      type: "movement-trace-clear"
    });
    expect(parseDevConsoleCommand("movement trace copy")).toEqual({
      type: "movement-trace-copy"
    });
  });

  it("parses spawn-count dev commands", () => {
    expect(parseDevConsoleCommand("spawns count")).toEqual({
      type: "spawns-count"
    });
    expect(parseDevConsoleCommand("resources vision")).toEqual({
      type: "resources-vision"
    });
    expect(parseDevConsoleCommand("resource vision")).toEqual({
      type: "resources-vision"
    });
  });
});
