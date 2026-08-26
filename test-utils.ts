export class MockExtensionAPI {
  tools: any[] = [];
  commands: Record<string, any> = {};
  events: Record<string, ((...args: any[]) => any)[]> = {};

  registerTool(spec: any) {
    this.tools.push(spec);
  }

  registerCommand(name: string, spec: any) {
    this.commands[name] = spec;
  }

  registerSlashCommand(spec: any) {
    this.commands[spec.name] = spec;
  }

  on(event: string, handler: (...args: any[]) => any) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(handler);
  }

  async emit(event: string, ...args: any[]) {
    const handlers = this.events[event] || [];
    for (const h of handlers) {
      await h(...args);
    }
  }
}
