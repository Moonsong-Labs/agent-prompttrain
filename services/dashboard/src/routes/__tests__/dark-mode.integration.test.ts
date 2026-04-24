import { describe, it, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { layout } from '../../layout/index.js'

describe('Dark Mode Integration', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    app.get('/test', c => {
      return c.html(layout('Test Page', '<div>Test Content</div>', '', c))
    })
  })

  it('should include theme toggle button in layout', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    expect(html).toContain('id="theme-toggle"')
    expect(html).toContain('title="Toggle dark mode"')
    expect(html).toContain('class="theme-toggle"')
  })

  it('should include both light and dark highlight.js themes', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    expect(html).toContain('id="hljs-light-theme"')
    expect(html).toContain(
      'href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css"'
    )
    expect(html).toContain('id="hljs-dark-theme"')
    expect(html).toContain(
      'href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css"'
    )
    expect(html).toContain('disabled')
  })

  it('can omit optional third-party assets for lightweight pages', async () => {
    app.get('/lite', c => {
      return c.html(
        layout('Lite Page', '<div>Lite Content</div>', '', c, {
          assets: {
            htmx: false,
            codeViewer: false,
          },
        })
      )
    })

    const res = await app.request('/lite')
    const html = await res.text()

    expect(html).not.toContain('highlight.min.js')
    expect(html).not.toContain('@andypf/json-viewer')
    expect(html).not.toContain('htmx.org@1.9.10')
  })

  it('should set data-theme attribute based on localStorage', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    // Check that the theme initialization script is present
    expect(html).toContain("localStorage.getItem('theme') || 'light'")
    expect(html).toContain("htmlElement.setAttribute('data-theme', currentTheme)")
  })

  it('should include theme switching JavaScript', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    // Check for theme toggle functionality
    expect(html).toContain("themeToggle.addEventListener('click'")
    expect(html).toContain("const newTheme = currentTheme === 'light' ? 'dark' : 'light'")
    expect(html).toContain("localStorage.setItem('theme', newTheme)")
    expect(html).toContain('function updateTheme(theme)')
    expect(html).toContain('function updateThemeIcon(theme)')
    expect(html).toContain('function updateHighlightTheme(theme)')
  })

  it('should apply correct CSS variables for light theme', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    // Check for light theme CSS variables
    expect(html).toContain(':root {')
    expect(html).toContain('--bg-primary: #f9fafb;')
    expect(html).toContain('--bg-secondary: #ffffff;')
    expect(html).toContain('--text-primary: #1f2937;')
    expect(html).toContain('--text-secondary: #6b7280;')
    expect(html).toContain('--btn-primary-bg: #3b82f6;')
  })

  it('should apply correct CSS variables for dark theme', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    // Check for dark theme CSS variables
    expect(html).toContain('[data-theme="dark"] {')
    expect(html).toContain('--bg-primary: #0f172a;')
    expect(html).toContain('--bg-secondary: #1e293b;')
    expect(html).toContain('--text-primary: #f1f5f9;')
    expect(html).toContain('--text-secondary: #cbd5e1;')
    expect(html).toContain('--btn-primary-bg: #2563eb;')
  })

  it('should include dark mode specific CSS adjustments', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    // Check for dark mode specific styles
    expect(html).toContain('[data-theme="dark"] .message-content pre')
    expect(html).toContain('[data-theme="dark"] .hljs')
    expect(html).toContain('/* Dark mode specific code block adjustments */')
  })

  it('should have theme icons in the toggle button', async () => {
    const res = await app.request('/test')
    const html = await res.text()

    // Check for sun icon (light theme)
    expect(html).toContain('id="theme-icon-light"')
    expect(html).toContain('M12 3v1m0 16v1m9-9h-1M4 12H3') // Part of sun icon path

    // Check for moon icon (dark theme)
    expect(html).toContain('id="theme-icon-dark"')
    expect(html).toContain('M20.354 15.354A9 9 0 018.646 3.646') // Part of moon icon path
    expect(html).toContain('style="display:none;"') // Dark icon initially hidden
  })
})
