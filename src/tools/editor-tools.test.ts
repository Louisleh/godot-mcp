import { describe, expect, it } from "vitest";
import { registerEditorTools } from "./editor-tools.js";

describe("editor tools", () => {
  it("accepts an empty runtime wait request so the runtime bridge can default to one frame", () => {
    const tools = new Map();
    registerEditorTools(tools as any, {
      projectPath: "/test/project",
      editorConnected: false,
      editorPort: 6550,
    });

    const runtimeWaitTool = tools.get("godot_runtime_wait");
    expect(runtimeWaitTool).toBeDefined();
    expect(runtimeWaitTool?.inputSchema.parse({})).toEqual({});
  });

  it("bounds live runtime inspection requests", () => {
    const tools = new Map();
    registerEditorTools(tools as any, {
      projectPath: "/test/project",
      editorConnected: false,
      editorPort: 6550,
    });

    const inspectTool = tools.get("godot_runtime_inspect_nodes");
    expect(inspectTool).toBeDefined();
    expect(
      inspectTool?.inputSchema.parse({
        group: "enemies",
        properties: ["health", "definition.max_health"],
        methods: ["is_on_floor"],
      })
    ).toMatchObject({
      group: "enemies",
      maxResults: 32,
    });
    expect(() =>
      inspectTool?.inputSchema.parse({ maxResults: 129 })
    ).toThrow();
  });

  it("limits raw key injection to a small deterministic key set", () => {
    const tools = new Map();
    registerEditorTools(tools as any, {
      projectPath: "/test/project",
      editorConnected: false,
      editorPort: 6550,
    });

    const tapKeyTool = tools.get("godot_runtime_tap_key");
    expect(tapKeyTool?.inputSchema.parse({ key: "enter" })).toEqual({
      key: "enter",
      frames: 1,
    });
    expect(() => tapKeyTool?.inputSchema.parse({ key: "a" })).toThrow();
  });
});
