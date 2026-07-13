import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}
describe("editor RPC contract", () => {
    it("uses a statically typed execute wrapper for strict-typing projects", () => {
        const pluginHandler = readProjectFile("addons/godot_ai_bridge/message_handler.gd");
        expect(pluginHandler).toContain("func __mcp_exec(editor_interface: Variant, message_handler: Variant) -> Variant:");
        expect(pluginHandler).toContain("var runner: Object = temp_script.new()");
    });
    it("keeps editor tool RPC methods in sync with plugin dispatch", () => {
        const editorTools = readProjectFile("src/tools/editor-tools.ts");
        const pluginHandler = readProjectFile("addons/godot_ai_bridge/message_handler.gd");
        const sentMethods = uniqueSorted([...editorTools.matchAll(/sendRequest\("([^"]+)"/g)].map((match) => match[1]));
        const dispatchStart = pluginHandler.indexOf("func _dispatch");
        const dispatchEnd = pluginHandler.indexOf("func _handle_initialize");
        const dispatchBlock = pluginHandler.slice(dispatchStart, dispatchEnd);
        const dispatchedMethods = uniqueSorted([...dispatchBlock.matchAll(/^\s*"([^"]+)":\s*$/gm)].map((match) => match[1]));
        const missingInPlugin = sentMethods.filter((method) => !dispatchedMethods.includes(method));
        expect(missingInPlugin).toEqual([]);
    });
    it("records the active bridge port after a successful connection", () => {
        const editorTools = readProjectFile("src/tools/editor-tools.ts");
        expect(editorTools).toContain("state.editorPort = port;");
    });
    it("provides bounded live node inspection through the runtime bridge", () => {
        const editorTools = readProjectFile("src/tools/editor-tools.ts");
        const runtimeBridge = readProjectFile("addons/godot_ai_bridge/runtime_bridge.gd");
        expect(editorTools).toContain('tools.set("godot_runtime_inspect_nodes"');
        expect(editorTools).toContain('sendRequest("runtime.inspect_nodes"');
        expect(runtimeBridge).toContain('"inspect_nodes":');
        expect(runtimeBridge).toContain("func _handle_inspect_nodes");
        expect(runtimeBridge).toContain("clampi(int(params.get(\"max_results\", 32)), 1, 128)");
        expect(runtimeBridge).toContain('"paused": get_tree().paused');
    });
    it("disconnects debugger-session signals during plugin shutdown", () => {
        const plugin = readProjectFile("addons/godot_ai_bridge/godot_ai_bridge.gd");
        expect(plugin).toContain("_debugger_plugin.shutdown()");
        expect(plugin).toContain("func shutdown() -> void:");
        expect(plugin).toContain("session.started.disconnect(started_callable)");
        expect(plugin).toContain("session.stopped.disconnect(stopped_callable)");
    });
    it("documents all plugin RPC methods in README", () => {
        const readme = readProjectFile("README.md");
        const pluginHandler = readProjectFile("addons/godot_ai_bridge/message_handler.gd");
        const sectionStart = readme.indexOf("### JSON-RPC Methods");
        const sectionEnd = readme.indexOf("\n---", sectionStart);
        const rpcSection = readme.slice(sectionStart, sectionEnd);
        const documentedMethods = uniqueSorted([...rpcSection.matchAll(/\|\s*`([^`]+)`\s*\|/g)].map((match) => match[1]));
        const dispatchStart = pluginHandler.indexOf("func _dispatch");
        const dispatchEnd = pluginHandler.indexOf("func _handle_initialize");
        const dispatchBlock = pluginHandler.slice(dispatchStart, dispatchEnd);
        const dispatchedMethods = uniqueSorted([...dispatchBlock.matchAll(/^\s*"([^"]+)":\s*$/gm)].map((match) => match[1]));
        const undocumented = dispatchedMethods.filter((method) => !documentedMethods.includes(method));
        expect(undocumented).toEqual([]);
    });
});
//# sourceMappingURL=editor-rpc-contract.test.js.map