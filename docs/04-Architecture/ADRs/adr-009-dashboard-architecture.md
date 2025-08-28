# ADR-009: Dashboard Architecture with HTMX and Server-Side Rendering

## Status

Accepted

## Context

The monitoring dashboard needed to display real-time metrics, conversation visualizations, and complex data relationships. Traditional approaches would use React, Vue, or another SPA framework, but we needed to consider:

- Bundle size and performance
- Development complexity
- Real-time updates
- SEO and accessibility
- Maintenance burden

The choice would significantly impact dashboard performance, development velocity, and user experience.

## Decision Drivers

- **Performance**: Fast initial load and interactions
- **Simplicity**: Minimal JavaScript complexity
- **Real-time Updates**: Live data without full page refreshes
- **Developer Experience**: Familiar patterns, easy debugging
- **Maintainability**: Long-term sustainability
- **Progressive Enhancement**: Works without JavaScript

## Considered Options

1. **React SPA**
   - Description: Client-side React application
   - Pros: Rich ecosystem, familiar to many developers
   - Cons: Bundle size, complexity, SEO challenges

2. **Vue.js SPA**
   - Description: Vue-based single-page application
   - Pros: Simpler than React, good docs
   - Cons: Still requires build pipeline, client-side state

3. **HTMX + Server-Side Rendering**
   - Description: HTML-over-the-wire with HTMX
   - Pros: Minimal JavaScript, progressive enhancement
   - Cons: Less familiar pattern, server does more work

4. **Traditional Server-Side**
   - Description: Full page refreshes, minimal JS
   - Pros: Simplest approach, best SEO
   - Cons: Poor UX for real-time data

## Decision

We will use **HTMX with server-side rendering** for the dashboard.

### Implementation Details

1. **Architecture Pattern**:

   ```html
   <!-- HTMX for dynamic updates -->
   <div hx-get="/api/stats" hx-trigger="every 5s" hx-target="#stats">
     <div id="stats">
       <!-- Server-rendered content -->
     </div>
   </div>
   ```

2. **Real-time Updates**:

   ```html
   <!-- SSE for live data -->
   <div hx-sse="connect:/api/sse">
     <div hx-sse="swap:message">
       <!-- Live updates here -->
     </div>
   </div>
   ```

3. **Graph Visualization**:

   ```typescript
   // Custom algorithm for conversation trees
   function calculateNodePositions(conversations: Conversation[]) {
     const layout = new TreeLayout({
       nodeWidth: 180,
       nodeHeight: 60,
       levelGap: 100,
       siblingGap: 20,
     })

     return layout.calculate(conversations)
   }
   ```

4. **Split-Pane Layout**:
   ```html
   <div class="split-pane">
     <div class="pane left" hx-get="/conversations/{id}" hx-target="#details">
       <!-- Conversation list -->
     </div>
     <div class="pane right" id="details">
       <!-- Conversation details -->
     </div>
   </div>
   ```

## Consequences

### Positive

- **Minimal JavaScript**: ~10KB vs ~200KB+ for React
- **Fast Time-to-Interactive**: No hydration needed
- **SEO Friendly**: Full server-side rendering
- **Progressive Enhancement**: Works without JS
- **Simple Debugging**: View source shows actual content
- **Lower Complexity**: No client-side state management

### Negative

- **Server Load**: More rendering work on server
- **Less Familiar**: Developers may need to learn HTMX
- **Limited Interactivity**: Complex interactions harder
- **Network Dependency**: Requires good connection

### Risks and Mitigations

- **Risk**: Poor performance with many concurrent users
  - **Mitigation**: Response caching (30s default)
  - **Mitigation**: CDN for static assets

- **Risk**: Complex interactions become difficult
  - **Mitigation**: Alpine.js for local state when needed
  - **Mitigation**: Custom elements for complex components

## Implementation Notes

- Introduced in PR #11
- Custom graph visualization without D3 or other libraries
- CSS Grid for responsive layouts
- Tailwind CSS for styling
- Server-sent events for real-time updates

## UI Components

1. **Stats Cards**: Auto-updating metrics
2. **Conversation Tree**: Interactive visualization
3. **Request Table**: Sortable, filterable data
4. **Token Usage Charts**: Real-time graphs
5. **Sub-task Nodes**: Tooltips and navigation

## Performance Optimizations

1. **Response Caching**: 30-second TTL by default
2. **Partial Updates**: Only update changed sections
3. **Lazy Loading**: Load details on demand
4. **CSS Containment**: Optimize render performance

## Future Enhancements

1. **WebSocket Support**: For higher-frequency updates
2. **Offline Support**: Service worker for resilience
3. **Export Features**: Generate reports client-side
4. **Keyboard Navigation**: Full accessibility
5. **Theme Support**: Dark mode and customization

## Links

- [PR #11: Enhanced Dashboard](https://github.com/Moonsong-Labs/agent-prompttrain/pull/11)
- [HTMX Documentation](https://htmx.org)
- [Dashboard Guide](../../02-User-Guide/dashboard-guide.md)

---

Date: 2024-06-25
Authors: Development Team
