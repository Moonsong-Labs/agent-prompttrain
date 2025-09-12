import { html, raw } from 'hono/html'
import { dashboardStyles } from './styles.js'
import { Context } from 'hono'
import { nexusLogo } from '../components/logo.js'

/**
 * Dashboard HTML layout template
 */
export const layout = (
  title: string,
  content: ReturnType<typeof html>,
  additionalScripts: string = '',
  context?: Context
) => {
  // Get CSRF token if context is provided
  const csrfToken = context?.get('csrfToken') || ''
  // Get auth state if context is provided
  const auth = context?.get('auth') || {
    isAuthenticated: false,
    isReadOnly: false,
    authType: 'none' as const,
  }

  return html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title} - Agent Prompt Train Dashboard</title>
        ${csrfToken ? html`<meta name="csrf-token" content="${csrfToken}" />` : ''}
        <style>
          ${raw(dashboardStyles)}
        
        /* Ultra-dense JSON viewer styles injected globally */
        andypf-json-viewer::part(json-viewer) {
            font-size: 10px !important;
            line-height: 1.1 !important;
          }

          andypf-json-viewer::part(key) {
            font-size: 10px !important;
          }

          andypf-json-viewer::part(value) {
            font-size: 10px !important;
          }

          andypf-json-viewer::part(row) {
            line-height: 1.1 !important;
            padding: 0 !important;
          }
        </style>
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css"
          id="hljs-light-theme"
        />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css"
          id="hljs-dark-theme"
          disabled
        />
        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/@andypf/json-viewer@2.1.10/dist/iife/index.js"></script>
        <style>
          /* JSON Viewer styling - Ultra Dense */
          andypf-json-viewer {
            display: block;
            padding: 0.5rem;
            border-radius: 0.25rem;
            overflow: auto;
            margin-bottom: 0.125rem;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;
            font-size: 10px;
            line-height: 1.2;
            letter-spacing: -0.03em;
            --json-viewer-indent: 12px;
            --json-viewer-key-color: #1e40af;
            --json-viewer-value-string-color: #059669;
            --json-viewer-value-number-color: #dc2626;
            --json-viewer-value-boolean-color: #7c3aed;
            --json-viewer-value-null-color: #6b7280;
            --json-viewer-property-color: #1e40af;
            --json-viewer-bracket-color: #6b7280;
            --json-viewer-comma-color: #6b7280;
          }

          /* Dark mode JSON viewer colors */
          [data-theme='dark'] andypf-json-viewer {
            --json-viewer-key-color: #60a5fa;
            --json-viewer-value-string-color: #34d399;
            --json-viewer-value-number-color: #f87171;
            --json-viewer-value-boolean-color: #a78bfa;
            --json-viewer-value-null-color: #94a3b8;
            --json-viewer-property-color: #60a5fa;
            --json-viewer-bracket-color: #94a3b8;
            --json-viewer-comma-color: #94a3b8;
          }

          /* Compact view - reduce padding on containers */
          #request-json-container andypf-json-viewer,
          #response-json-container andypf-json-viewer {
            padding: 0.25rem;
            margin-bottom: 0;
          }

          /* Make the overall section more compact */
          #raw-view .section-content {
            padding: 0.25rem;
          }

          /* Reduce spacing between sections */
          .section {
            margin-bottom: 0.5rem;
          }

          .section-header {
            padding: 0.375rem 0.5rem;
            font-size: 0.875rem;
          }

          .section-content {
            padding: 0.375rem;
          }

          /* Dense view toggle buttons */
          .view-toggle {
            margin: 0.5rem 0;
          }

          .view-toggle button {
            padding: 0.25rem 0.75rem;
            font-size: 0.8125rem;
          }

          /* Ensure code blocks in these containers have light backgrounds */
          .hljs {
            background: transparent !important;
            color: #1f2937 !important;
          }

          /* Chunk containers */
          #chunks-container > div > div {
            background-color: white !important;
          }

          /* Tool use and conversation code blocks */
          .message-content pre,
          .message-content code,
          .conversation-container pre,
          .conversation-container code {
            background-color: #f9fafb !important;
            color: #1f2937 !important;
            border: 1px solid #e5e7eb;
          }

          .message-content pre code,
          .conversation-container pre code {
            background-color: transparent !important;
            border: none;
          }

          /* Specific language code blocks */
          .language-json,
          .language-javascript,
          .language-python,
          .language-bash,
          .language-shell,
          pre.hljs,
          code.hljs {
            background-color: #f9fafb !important;
            color: #1f2937 !important;
          }
        </style>
        <script src="https://unpkg.com/htmx.org@1.9.10"></script>
        ${
          csrfToken
            ? raw(`
      <script>
        // Add CSRF token to all HTMX requests
        document.addEventListener('DOMContentLoaded', function() {
          document.body.addEventListener('htmx:configRequest', function(evt) {
            const token = document.querySelector('meta[name="csrf-token"]')?.content;
            if (token) {
              evt.detail.headers['X-CSRF-Token'] = token;
            }
          });
        });
      </script>`)
            : ''
        }
        ${additionalScripts}
      </head>
      <body${auth.isReadOnly ? ' class="read-only-mode"' : ''}>
        ${
          auth.isReadOnly
            ? html`
                <div
                  class="read-only-banner"
                  style="background-color: #fbbf24; color: #000; text-align: center; padding: 0.5rem; font-weight: bold; position: sticky; top: 0; z-index: 100;"
                >
                  Dashboard is running in Read-Only Mode
                </div>
              `
            : ''
        }
        <nav>
          <div class="container">
            <h1 style="display: flex; align-items: center; gap: 0.5rem;">
              ${raw(nexusLogo())}
              <span>Agent Prompt Train Dashboard</span>
            </h1>
            <div class="space-x-4" style="display: flex; align-items: center;">
              <a href="/dashboard" class="text-sm text-blue-600">Dashboard</a>
              <a href="/dashboard/requests" class="text-sm text-blue-600">Requests</a>
              <a href="/dashboard/usage" class="text-sm text-blue-600">Domain Stats</a>
              <a href="/dashboard/token-usage" class="text-sm text-blue-600">Token Usage</a>
              <a href="/dashboard/prompts" class="text-sm text-blue-600">Prompts</a>
              <span class="text-sm text-gray-600" id="current-domain">All Domains</span>
              ${
                auth.authType === 'oauth' && auth.user
                  ? html`
                      <div class="user-menu" style="position: relative;">
                        <button
                          class="user-button"
                          style="display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.75rem; background: #f3f4f6; border-radius: 0.375rem; border: 1px solid #e5e7eb; cursor: pointer;"
                          onclick="document.getElementById('user-dropdown').classList.toggle('show')"
                        >
                          <span class="text-sm">${auth.user.email}</span>
                          <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
                            <path
                              fill-rule="evenodd"
                              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                              clip-rule="evenodd"
                            />
                          </svg>
                        </button>
                        <div
                          id="user-dropdown"
                          class="dropdown-menu"
                          style="display: none; position: absolute; right: 0; top: 100%; margin-top: 0.25rem; background: white; border: 1px solid #e5e7eb; border-radius: 0.375rem; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); min-width: 200px; z-index: 50;"
                        >
                          <div style="padding: 0.75rem; border-bottom: 1px solid #e5e7eb;">
                            <div class="text-sm font-medium">
                              ${auth.user.name || auth.user.email}
                            </div>
                            <div class="text-xs text-gray-500">${auth.user.email}</div>
                          </div>
                          <a
                            href="/dashboard/logout"
                            class="text-sm"
                            style="display: block; padding: 0.5rem 0.75rem; color: #374151; text-decoration: none; hover:background-color: #f3f4f6;"
                            onmouseover="this.style.backgroundColor='#f3f4f6'"
                            onmouseout="this.style.backgroundColor='transparent'"
                          >
                            Sign out
                          </a>
                        </div>
                      </div>
                      <style>
                        .dropdown-menu.show {
                          display: block !important;
                        }
                        [data-theme='dark'] .user-button {
                          background: #374151 !important;
                          border-color: #4b5563 !important;
                        }
                        [data-theme='dark'] .dropdown-menu {
                          background: #1f2937 !important;
                          border-color: #374151 !important;
                        }
                        [data-theme='dark'] .dropdown-menu a:hover {
                          background-color: #374151 !important;
                        }
                      </style>
                      <script>
                        // Close dropdown when clicking outside
                        document.addEventListener('click', function (event) {
                          const dropdown = document.getElementById('user-dropdown')
                          const button = event.target.closest('.user-button')
                          if (!button && !dropdown.contains(event.target)) {
                            dropdown.classList.remove('show')
                          }
                        })
                      </script>
                    `
                  : !auth.isReadOnly
                    ? html`<a href="/dashboard/logout" class="text-sm text-blue-600">Logout</a>`
                    : ''
              }
              <button class="theme-toggle" id="theme-toggle" title="Toggle dark mode">
                <svg
                  id="theme-icon-light"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
                <svg
                  id="theme-icon-dark"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  style="display:none;"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                  />
                </svg>
              </button>
            </div>
          </div>
        </nav>
        <div id="toast-container"></div>
        <main class="container" style="padding: 2rem 1rem;">${content}</main>
        <script>
          // Dark mode functionality
          ;(function () {
            const themeToggle = document.getElementById('theme-toggle')
            const lightIcon = document.getElementById('theme-icon-light')
            const darkIcon = document.getElementById('theme-icon-dark')
            const htmlElement = document.documentElement
            const hljsLightTheme = document.getElementById('hljs-light-theme')
            const hljsDarkTheme = document.getElementById('hljs-dark-theme')

            // Check for saved theme preference or default to light mode
            const currentTheme = localStorage.getItem('theme') || 'light'
            htmlElement.setAttribute('data-theme', currentTheme)
            updateTheme(currentTheme)

            // Theme toggle functionality
            themeToggle.addEventListener('click', function () {
              const currentTheme = htmlElement.getAttribute('data-theme')
              const newTheme = currentTheme === 'light' ? 'dark' : 'light'

              htmlElement.setAttribute('data-theme', newTheme)
              localStorage.setItem('theme', newTheme)
              updateTheme(newTheme)
            })

            function updateTheme(theme) {
              updateThemeIcon(theme)
              updateHighlightTheme(theme)
            }

            function updateThemeIcon(theme) {
              if (theme === 'dark') {
                lightIcon.style.display = 'none'
                darkIcon.style.display = 'block'
              } else {
                lightIcon.style.display = 'block'
                darkIcon.style.display = 'none'
              }
            }

            function updateHighlightTheme(theme) {
              if (theme === 'dark') {
                hljsLightTheme.disabled = true
                hljsDarkTheme.disabled = false
              } else {
                hljsLightTheme.disabled = false
                hljsDarkTheme.disabled = true
              }
            }
          })()
        </script>
      </body>
    </html>
  `
}
