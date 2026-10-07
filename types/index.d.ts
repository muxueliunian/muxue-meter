// The $.state values muxue-meter keeps for a session (they survive a hot reload).

export type MuxueMeterTps = { value: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    'muxue-meter': {
      view: 'hidden' | 'brief' | 'full'
      editingName: boolean
      tps: MuxueMeterTps | null
      tab: 'usage' | 'quota' | 'models' | 'daily'
    }
  }
}
