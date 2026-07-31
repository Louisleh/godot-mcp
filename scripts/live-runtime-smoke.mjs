#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = join(repositoryRoot, "tests", "fixtures", "runtime-project");
const projectPath = await mkdtemp(join(tmpdir(), "godot-mcp-runtime-"));
const editorPort = 6550;
const godotExecutable = process.env.GODOT4 ?? process.env.GODOT ?? "godot";
const editorOutput = [];
let editor;
let client;

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function waitForPort(port, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolveWait();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          rejectWait(new Error(`Godot AI Bridge did not open port ${port}.`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function callTool(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((entry) => entry.type === "text")?.text ?? "{}";
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`${name} returned a non-JSON response: ${text}`);
  }
  if (response.isError || result?.error) {
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

async function waitForRuntime(timeoutMilliseconds = 10000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await callTool("godot_runtime_status");
      if (status.available && status.scene_path === "res://main.tscn") return status;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error("Runtime fixture did not become available.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await cp(fixtureSource, projectPath, { recursive: true });
  const addonTarget = join(projectPath, "addons", "godot_ai_bridge");
  await mkdir(dirname(addonTarget), { recursive: true });
  await cp(join(repositoryRoot, "addons", "godot_ai_bridge"), addonTarget, {
    recursive: true,
  });

  editor = spawn(
    godotExecutable,
    ["--headless", "--editor", "--path", projectPath],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  editor.stdout.on("data", (chunk) => editorOutput.push(chunk.toString()));
  editor.stderr.on("data", (chunk) => editorOutput.push(chunk.toString()));
  editor.once("error", (error) => editorOutput.push(String(error)));
  await waitForPort(editorPort);
  // The bridge opens its socket during plugin initialization, before the editor
  // finishes scanning scripts and registering the temporary runtime autoload.
  await wait(1500);

  client = new Client({ name: "godot-mcp-live-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(repositoryRoot, "dist", "index.js"),
      "--project",
      projectPath,
      "--port",
      String(editorPort),
    ],
    stderr: "inherit",
  });
  await client.connect(transport);
  await callTool("godot_connect", { host: "127.0.0.1", port: editorPort });
  await callTool("godot_editor_get_project_info");
  await callTool("godot_editor_run_scene", { scenePath: "res://main.tscn" });
  const status = await waitForRuntime();
  assert(status.paused === false, "Runtime status should report an unpaused tree.");
  assert(status.node_count >= 7, "Runtime status should report fixture nodes.");

  const root = await callTool("godot_runtime_inspect_nodes", {
    group: "audit_nodes",
    properties: ["health", "key_events", "cyclic_data"],
    maxResults: 1,
    maxVisited: 4,
  });
  assert(root.count === 1, "Expected one audit root.");
  assert(root.truncated === false, "An exact one-node result must not be truncated.");
  assert(root.nodes[0].properties.health === 42, "Expected readable runtime health.");
  assert(!("methods" in root.nodes[0]), "Inspection must not expose method execution.");
  assert(
    root.nodes[0].properties.cyclic_data.self.self.self.self.truncated === true,
    "Recursive property data must stop at the serialization depth bound."
  );

  const exact = await callTool("godot_runtime_inspect_nodes", {
    group: "exact_nodes",
    maxResults: 2,
    maxVisited: 4,
  });
  assert(exact.count === 2, "Expected both exact group nodes.");
  assert(exact.truncated === false, "An exact result cap must not report truncation.");

  const overflow = await callTool("godot_runtime_inspect_nodes", {
    group: "overflow_nodes",
    maxResults: 2,
    maxVisited: 4,
  });
  assert(overflow.count === 2, "Expected the bounded overflow result.");
  assert(overflow.truncated === true, "A third matching node must report truncation.");

  const visitLimited = await callTool("godot_runtime_inspect_nodes", {
    group: "overflow_nodes",
    maxResults: 4,
    maxVisited: 1,
  });
  assert(visitLimited.count === 1, "Visit limit should bound inspected candidates.");
  assert(visitLimited.visited_count === 1, "Visit count should report bounded work.");
  assert(visitLimited.truncated === true, "A visit-limited result must report truncation.");

  await callTool("godot_runtime_tap_key", { key: "enter", frames: 1 });
  const afterKey = await callTool("godot_runtime_inspect_nodes", {
    group: "audit_nodes",
    properties: ["key_events"],
    maxResults: 1,
  });
  assert(afterKey.nodes[0].properties.key_events === 1, "Raw key input was not delivered.");

  await callTool("godot_editor_stop_scene");
  await callTool("godot_disconnect");
  process.stdout.write("Godot live runtime smoke test passed.\n");
} catch (error) {
  process.stderr.write(`${editorOutput.join("")}\n`);
  throw error;
} finally {
  if (client) await client.close();
  if (editor && editor.exitCode === null) {
    editor.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => editor.once("exit", resolveExit)),
      wait(3000),
    ]);
    if (editor.exitCode === null) editor.kill("SIGKILL");
  }
  await rm(projectPath, { recursive: true, force: true });
}
