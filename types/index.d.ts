// The $.state values usage-panel keeps for a session (they survive a hot reload).

export type UsagePanelTps = { value: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-panel': {
      expanded: boolean
      editingName: boolean
      tps: UsagePanelTps | null
    }
  }
}
