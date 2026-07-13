#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectPath = resolve(process.argv[2] ?? process.cwd());
const outputDir = resolve(process.argv[3] ?? "/tmp/cobie-mcp-evidence");
const port = Number(process.argv[4] ?? 6550);
await mkdir(outputDir, { recursive: true });

const client = new Client({ name: "cobie-live-bakeoff", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js"), "--project", projectPath, "--port", String(port)],
  stderr: "inherit",
});

const steps = [];
async function call(name, args = {}) {
  const started = Date.now();
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text ?? "{}";
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  const step = {
    name,
    args,
    duration_ms: Date.now() - started,
    result,
    is_error: Boolean(response.isError),
  };
  steps.push(step);
  if (step.is_error) throw new Error(`${name}: ${text}`);
  return result;
}

async function waitForScene(fragment, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const status = await call("godot_runtime_status");
    if (String(status.scene_path ?? "").includes(fragment)) return status;
    await call("godot_runtime_wait", { frames: 10 });
  }
  throw new Error(`Scene containing ${fragment} did not become active.`);
}

async function screenshot(name) {
  return call("godot_runtime_capture_screenshot", {
    path: resolve(outputDir, name),
  });
}

try {
  await client.connect(transport);
  await call("godot_connect", { host: "127.0.0.1", port });
  await call("godot_editor_get_project_info");
  await call("godot_editor_get_scene_tree");
  await call("godot_editor_get_errors", {
    severity: "error",
    includeRuntime: true,
    includeScript: true,
    includeLogFile: true,
    logLines: 300,
  });
  await call("godot_editor_run_scene", { scenePath: "res://scenes/boot/boot.tscn" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
  await waitForScene("title_screen");
  for (let index = 0; index < 4; index += 1) {
    await call("godot_runtime_wait", { frames: 150 });
  }
  await screenshot("01-title-ready.png");

  // The title screen deliberately requires a physical input event, not merely an
  // InputMap action. This verifies raw keyboard injection through the Viewport.
  await call("godot_runtime_tap_key", { key: "enter", frames: 2 });
  await waitForScene("menu.tscn");
  await screenshot("02-main-menu.png");

  await call("godot_runtime_tap_key", { key: "enter", frames: 2 });
  await waitForScene("level_select");
  await screenshot("03-level-select.png");

  await call("godot_runtime_click", { x: 590, y: 347, button: 1, holdFrames: 2 });
  await waitForScene("episode_1_level_1", 90);
  await call("godot_runtime_wait", { frames: 180 });
  await screenshot("04-gameplay.png");

  const playerBefore = await call("godot_runtime_inspect_nodes", {
    group: "player",
    properties: ["velocity", "is_dead", "current_weapon_index", "health_armor.health", "health_armor.armor"],
    methods: ["is_on_floor"],
    maxResults: 4,
  });
  const enemies = await call("godot_runtime_inspect_nodes", {
    group: "enemies",
    properties: ["health", "is_dead", "state", "definition.max_health", "definition.display_name"],
    methods: ["is_on_floor"],
    maxResults: 16,
  });
  const pickups = await call("godot_runtime_inspect_nodes", {
    scriptPath: "res://scripts/combat/pickup.gd",
    properties: ["definition.id", "definition.kind", "_available", "monitoring"],
    maxResults: 32,
  });
  if (playerBefore.count < 1) throw new Error("Live player inspection returned no player.");
  if (enemies.count < 1) throw new Error("Live enemy inspection returned no enemies.");
  if (pickups.count < 1) throw new Error("Live pickup inspection returned no pickups.");

  await call("godot_runtime_press_action", { action: "move_forward", strength: 1 });
  await call("godot_runtime_wait", { frames: 30 });
  await call("godot_runtime_release_action", { action: "move_forward" });
  const playerAfter = await call("godot_runtime_inspect_nodes", {
    group: "player",
    properties: ["velocity", "is_dead", "current_weapon_index", "health_armor.health"],
    methods: ["is_on_floor"],
    maxResults: 4,
  });
  const beforePosition = playerBefore.nodes[0]?.global_position;
  const afterPosition = playerAfter.nodes[0]?.global_position;
  if (JSON.stringify(beforePosition) === JSON.stringify(afterPosition)) {
    throw new Error("Player position did not change after live movement input.");
  }

  await call("godot_runtime_tap_action", { action: "weapon_next", frames: 2 });
  await call("godot_runtime_tap_action", { action: "fire_primary", frames: 2 });
  await call("godot_runtime_wait", { frames: 8 });
  await screenshot("05-fired.png");
  await call("godot_runtime_tap_action", { action: "reload", frames: 2 });
  await call("godot_runtime_wait", { frames: 80 });

  await call("godot_runtime_tap_action", { action: "pause", frames: 2 });
  const pausedStatus = await call("godot_runtime_status");
  if (!pausedStatus.paused) throw new Error("Pause action did not pause the live scene tree.");
  await screenshot("06-paused.png");
  await call("godot_runtime_tap_action", { action: "pause", frames: 2 });
  await call("godot_runtime_wait", { frames: 5 });
  const resumedStatus = await call("godot_runtime_status");
  if (resumedStatus.paused) throw new Error("Second pause action did not resume gameplay.");

  const errors = await call("godot_editor_get_errors", {
    severity: "error",
    includeRuntime: true,
    includeScript: true,
    includeLogFile: true,
    logLines: 600,
  });
  if (errors.count > 0) throw new Error(`Godot reported ${errors.count} errors during the bake-off.`);
  await call("godot_editor_get_output", { lines: 600 });
  await call("godot_editor_stop_scene");
  await call("godot_disconnect");
  await writeFile(resolve(outputDir, "result.json"), JSON.stringify({ projectPath, port, steps }, null, 2));
  process.stdout.write(`${JSON.stringify({ steps: steps.length, outputDir }, null, 2)}\n`);
} catch (error) {
  await writeFile(resolve(outputDir, "result.json"), JSON.stringify({ projectPath, port, steps, error: String(error) }, null, 2));
  throw error;
} finally {
  await client.close();
}
