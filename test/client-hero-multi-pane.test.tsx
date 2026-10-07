// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { cloneElement } = await import('react')
  return {
    IconBranchOutlineRegular: () => <svg data-icon="branch" />,
    IconCheckOutlineRegular: () => <svg data-icon="check" />,
    IconChevronDownOutlineRegular: () => <svg data-icon="chevron-down" />,
    IconRefreshOutlineRegular: () => <svg data-icon="refresh" />,
    IconSearchOutlineRegular: () => <svg data-icon="search" />,
    Tooltip: ({ label, children }: { label: string; children: React.ReactElement }) =>
      cloneElement(children, { 'data-tooltip': label } as Record<string, unknown>),
  }
})

// Each pane's repository answers with a branch named after it, so the markup
// shows which pane's controls landed where.
vi.mock('../src/client/repository-setup-api.ts', () => ({
  loadRepositoryBranches: (cwd: string) => Promise.resolve({ root: cwd, current: `branch-of-${cwd}`, dirty: false, branches: [`branch-of-${cwd}`], remoteBranches: [] }),
  refreshRepositoryBranches: vi.fn(),
}))
vi.mock('../src/client/jira-api.ts', () => ({
  JiraClientError: class extends Error {},
  loadJiraStatus: () => Promise.resolve({ connected: false }),
  searchJiraTickets: vi.fn(),
}))

import { ClaudeHeroRepositoryControls, type ClaudeHeroRepositoryControlsProps } from '../src/client/ClaudeHeroRepositoryControls.tsx'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PORTAL = '[data-dsh-claude-hero-controls]'
const roots: Root[] = []

/** One conversation per pane, as dsh-multi-panel lays them out: a phased root
 *  holding the hero row (hero phase only), the input dock and the composer. */
function pane(id: string, phase: 'hero' | 'active'): HTMLElement {
  const element = document.createElement('div')
  element.dataset.pane = id
  element.innerHTML = `
    <div data-phase="${phase}">
      ${phase === 'hero' ? `<div>
        <span><button aria-haspopup="menu" aria-label="workspace">${id}</button></span>
        <span><button aria-haspopup="menu">Claude</button></span>
      </div>` : ''}
      <div data-dock></div>
      <div data-composer-card><div data-composer-input role="textbox"></div><button>send</button></div>
    </div>`
  document.body.append(element)
  return element
}

async function mountControls(host: HTMLElement, sessionId: string, prepare = vi.fn(() => Promise.resolve())): Promise<Root> {
  const dock = host.querySelector('[data-dock]')
  if (dock === null) throw new Error('fixture has no dock')
  const root = createRoot(dock)
  roots.push(root)
  const props = {
    sessionId,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { [sessionId]: { cwd: `/repo/${sessionId}` } } }),
    useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [] }),
    input: { draft: 'ship it' },
    t: (key: string) => key,
    prepare,
    prepareMany: vi.fn(),
  } as unknown as ClaudeHeroRepositoryControlsProps
  await act(async () => { root.render(<ClaudeHeroRepositoryControls {...props} />) })
  await act(async () => { await Promise.resolve() })
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.innerHTML = ''
})

describe('hero repository controls across split panes', () => {
  it('renders only the hero pane\'s own controls, once', async () => {
    const hero = pane('a', 'hero')
    const active = pane('b', 'active')
    await mountControls(hero, 'a')
    await mountControls(active, 'b')

    const portals = document.querySelectorAll(PORTAL)
    expect(portals).toHaveLength(1)
    expect(hero.contains(portals[0] ?? null)).toBe(true)
    expect(portals[0]?.children).toHaveLength(1)
    expect(portals[0]?.textContent).toContain('branch-of-/repo/a')
    expect(portals[0]?.textContent).not.toContain('branch-of-/repo/b')
  })

  it('gives every pane showing a hero its own controls', async () => {
    const left = pane('a', 'hero')
    const right = pane('b', 'hero')
    await mountControls(left, 'a')
    await mountControls(right, 'b')

    expect(left.querySelector(PORTAL)?.textContent).toContain('branch-of-/repo/a')
    expect(right.querySelector(PORTAL)?.textContent).toContain('branch-of-/repo/b')
  })

  it('leaves the other pane\'s controls up when one pane\'s controls unmount', async () => {
    const left = pane('a', 'hero')
    const right = pane('b', 'hero')
    await mountControls(left, 'a')
    const rightRoot = await mountControls(right, 'b')

    act(() => { rightRoot.unmount() })

    expect(right.querySelector(PORTAL)).toBeNull()
    expect(left.querySelector(PORTAL)?.textContent).toContain('branch-of-/repo/a')
  })

  it('submits through a pane\'s worktree only from that pane\'s composer', async () => {
    const left = pane('a', 'hero')
    const right = pane('b', 'hero')
    const prepareLeft = vi.fn(() => Promise.resolve())
    await mountControls(left, 'a', prepareLeft)
    await mountControls(right, 'b')
    const worktree = left.querySelector<HTMLElement>(`${PORTAL} [role="checkbox"]`)
    if (worktree === null) throw new Error('worktree toggle missing')
    act(() => { worktree.click() })

    const rightComposer = right.querySelector('[data-composer-input]')
    act(() => { rightComposer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(prepareLeft).not.toHaveBeenCalled()

    const leftComposer = left.querySelector('[data-composer-input]')
    await act(async () => { leftComposer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(prepareLeft).toHaveBeenCalledTimes(1)
  })
})
