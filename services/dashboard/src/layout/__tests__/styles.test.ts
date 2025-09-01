import { describe, it, expect } from 'bun:test'
import { dashboardStyles } from '../styles.js'

describe('Dark Mode CSS Variables', () => {
  const extractCSSVariables = (styles: string, selector: string): Record<string, string> => {
    const selectorRegex = new RegExp(`${selector}\\s*{([^}]+)}`, 's')
    const match = styles.match(selectorRegex)
    if (!match) {
      return {}
    }

    const varRegex = /--[\w-]+:\s*[^;]+/g
    const matches = match[1].match(varRegex) || []
    return matches.reduce(
      (acc, match) => {
        const [key, value] = match.split(':').map(s => s.trim())
        acc[key] = value
        return acc
      },
      {} as Record<string, string>
    )
  }

  it('should define all required CSS variables for light theme', () => {
    const lightVars = extractCSSVariables(dashboardStyles, ':root')

    // Background colors
    expect(lightVars['--bg-primary']).toBeDefined()
    expect(lightVars['--bg-secondary']).toBeDefined()
    expect(lightVars['--bg-tertiary']).toBeDefined()
    expect(lightVars['--bg-dark-section']).toBeDefined()

    // Text colors
    expect(lightVars['--text-primary']).toBeDefined()
    expect(lightVars['--text-secondary']).toBeDefined()
    expect(lightVars['--text-tertiary']).toBeDefined()
    expect(lightVars['--text-link']).toBeDefined()
    expect(lightVars['--text-link-hover']).toBeDefined()

    // Border colors
    expect(lightVars['--border-color']).toBeDefined()
    expect(lightVars['--border-color-light']).toBeDefined()

    // Button colors
    expect(lightVars['--btn-primary-bg']).toBeDefined()
    expect(lightVars['--btn-primary-hover']).toBeDefined()
    expect(lightVars['--btn-secondary-bg']).toBeDefined()
    expect(lightVars['--btn-secondary-hover']).toBeDefined()

    // Status colors
    expect(lightVars['--color-success']).toBeDefined()
    expect(lightVars['--color-error']).toBeDefined()
    expect(lightVars['--color-warning']).toBeDefined()
    expect(lightVars['--color-info']).toBeDefined()
  })

  it('should define all required CSS variables for dark theme', () => {
    const darkVars = extractCSSVariables(dashboardStyles, '\\[data-theme="dark"\\]')

    // Background colors
    expect(darkVars['--bg-primary']).toBeDefined()
    expect(darkVars['--bg-secondary']).toBeDefined()
    expect(darkVars['--bg-tertiary']).toBeDefined()
    expect(darkVars['--bg-dark-section']).toBeDefined()

    // Text colors
    expect(darkVars['--text-primary']).toBeDefined()
    expect(darkVars['--text-secondary']).toBeDefined()
    expect(darkVars['--text-tertiary']).toBeDefined()
    expect(darkVars['--text-link']).toBeDefined()
    expect(darkVars['--text-link-hover']).toBeDefined()

    // Border colors
    expect(darkVars['--border-color']).toBeDefined()
    expect(darkVars['--border-color-light']).toBeDefined()

    // Button colors
    expect(darkVars['--btn-primary-bg']).toBeDefined()
    expect(darkVars['--btn-primary-hover']).toBeDefined()
    expect(darkVars['--btn-secondary-bg']).toBeDefined()
    expect(darkVars['--btn-secondary-hover']).toBeDefined()
  })

  it('should have correct color values for light theme', () => {
    const lightVars = extractCSSVariables(dashboardStyles, ':root')

    expect(lightVars['--bg-primary']).toBe('#f9fafb')
    expect(lightVars['--bg-secondary']).toBe('#ffffff')
    expect(lightVars['--text-primary']).toBe('#1f2937')
    expect(lightVars['--text-secondary']).toBe('#6b7280')
    expect(lightVars['--border-color']).toBe('#e5e7eb')
    expect(lightVars['--btn-primary-bg']).toBe('#3b82f6')
  })

  it('should have correct color values for dark theme', () => {
    const darkVars = extractCSSVariables(dashboardStyles, '\\[data-theme="dark"\\]')

    expect(darkVars['--bg-primary']).toBe('#0f172a')
    expect(darkVars['--bg-secondary']).toBe('#1e293b')
    expect(darkVars['--text-primary']).toBe('#f1f5f9')
    expect(darkVars['--text-secondary']).toBe('#cbd5e1')
    expect(darkVars['--border-color']).toBe('#334155')
    expect(darkVars['--btn-primary-bg']).toBe('#2563eb')
  })

  it('should include theme toggle styles', () => {
    expect(dashboardStyles).toContain('.theme-toggle {')
    expect(dashboardStyles).toContain('width: 36px')
    expect(dashboardStyles).toContain('height: 36px')
    expect(dashboardStyles).toContain('.theme-toggle:hover {')
    expect(dashboardStyles).toContain('.theme-toggle svg {')
  })

  it('should include dark mode specific adjustments', () => {
    // Check for dark mode code block adjustments
    expect(dashboardStyles).toContain('[data-theme="dark"] .message-content pre')
    expect(dashboardStyles).toContain('[data-theme="dark"] .message-content code')
    expect(dashboardStyles).toContain('[data-theme="dark"] .hljs')

    // Check that styles use CSS variables
    expect(dashboardStyles).toContain('background: var(--bg-secondary)')
    expect(dashboardStyles).toContain('color: var(--text-primary)')
    expect(dashboardStyles).toContain('border-color: var(--border-color)')
  })

  it('should define message-specific color variables', () => {
    const lightVars = extractCSSVariables(dashboardStyles, ':root')
    const darkVars = extractCSSVariables(dashboardStyles, '\\[data-theme="dark"\\]')

    // Light theme message colors
    expect(lightVars['--msg-user-bg']).toBe('#eff6ff')
    expect(lightVars['--msg-assistant-bg']).toBe('#ffffff')
    expect(lightVars['--msg-tool-use-bg']).toBe('#fef3c7')
    expect(lightVars['--msg-tool-result-bg']).toBe('#f3e8ff')

    // Dark theme message colors
    expect(darkVars['--msg-user-bg']).toBe('#1e3a8a')
    expect(darkVars['--msg-assistant-bg']).toBe('#1e293b')
    expect(darkVars['--msg-tool-use-bg']).toBe('#78350f')
    expect(darkVars['--msg-tool-result-bg']).toBe('#4c1d95')
  })
})
