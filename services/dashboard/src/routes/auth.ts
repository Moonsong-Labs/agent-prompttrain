import { Hono } from 'hono'
import { html } from 'hono/html'

export const authRoutes = new Hono()

/**
 * Logout - clears any local state and redirects to dashboard
 * Note: With oauth2-proxy, the user will be immediately re-authenticated
 */
authRoutes.get('/logout', c => {
  return c.html(html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Logout</title>
      </head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>Logged Out</h1>
        <p>You have been logged out from the dashboard.</p>
        <p>To log out completely, please close your browser or clear your cookies.</p>
        <a href="/dashboard" style="color: #3b82f6; text-decoration: underline;">
          Return to Dashboard
        </a>
      </body>
    </html>
  `)
})
