import type { AgentPlan, AgentPolicy, BrowserAction, PolicyContext } from './types.ts'

export class ScriptedPolicy implements AgentPolicy {
  private cursor = 0

  constructor(
    private readonly plan: AgentPlan,
    private readonly actions: BrowserAction[],
  ) {}

  async createPlan(_context: PolicyContext): Promise<AgentPlan> {
    return structuredClone(this.plan)
  }

  async nextAction(_context: PolicyContext): Promise<BrowserAction> {
    const action = this.actions[this.cursor]
    if (!action) throw new Error('Scripted policy ran out of actions')
    this.cursor += 1
    return structuredClone(action)
  }
}
