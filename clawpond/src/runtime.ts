// Simple runtime store for ClawPond plugin
export type PluginRuntime = any; // Accept any runtime object for now

let _runtime: PluginRuntime | null = null;

export function setClawPondRuntime(runtime: PluginRuntime): void {
  _runtime = runtime;
}

export function getClawPondRuntime(): PluginRuntime | null {
  return _runtime;
}