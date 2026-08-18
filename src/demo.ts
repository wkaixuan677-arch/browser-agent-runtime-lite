import { BrowserAgentRuntime } from './runtime.ts'
import { BrowserTools } from './browser-tools.ts'
import { ScriptedPolicy } from './policy.ts'
import { startFixtureServer } from './fixture-server.ts'
import { happyActions, recoveryActions, reportPlan, reportTask } from './scenarios.ts'
import type { RunResult } from './types.ts'
import { launchBrowser } from './launch-browser.ts'

const fixture = await startFixtureServer()
const browser = await launchBrowser()

try {
  const results: RunResult[] = []
  results.push(await execute('happy-path', happyActions()))
  results.push(await execute('bounded-recovery', recoveryActions()))

  const blockedContext = await browser.newContext()
  try {
    const blockedTask = { ...reportTask(fixture.origin, 'explicit-blocked'), startUrl: `${fixture.origin}/blocked` }
    const blockedRuntime = new BrowserAgentRuntime(new ScriptedPolicy(reportPlan, happyActions()), new BrowserTools(await blockedContext.newPage(), [fixture.origin]))
    results.push(await blockedRuntime.run(blockedTask))
  } finally {
    await blockedContext.close()
  }

  for (const result of results) {
    console.log(`${result.taskId}: ${result.status.toUpperCase()} | steps=${result.steps} recoveries=${result.recoveries}`)
    console.log(`  ${result.answer}`)
    console.log(`  phases=${result.trajectory.map((event) => event.phase.toUpperCase()).filter((phase, index, all) => index === 0 || all[index - 1] !== phase).join(' → ')}`)
  }
} finally {
  await browser.close()
  await fixture.close()
}

async function execute(id: string, actions: ReturnType<typeof happyActions>): Promise<RunResult> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const runtime = new BrowserAgentRuntime(new ScriptedPolicy(reportPlan, actions), new BrowserTools(page, [fixture.origin]))
    return await runtime.run(reportTask(fixture.origin, id))
  } finally {
    await context.close()
  }
}
