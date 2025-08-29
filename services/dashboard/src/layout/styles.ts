/**
 * Dashboard CSS styles
 */
export const dashboardStyles = `
  /* CSS Variables for theming */
  :root {
    /* Light theme colors */
    --bg-primary: #f9fafb;
    --bg-secondary: #ffffff;
    --bg-tertiary: #f3f4f6;
    --bg-dark-section: #111827;
    
    --text-primary: #1f2937;
    --text-secondary: #6b7280;
    --text-tertiary: #9ca3af;
    --text-link: #2563eb;
    --text-link-hover: #1d4ed8;
    
    --border-color: #e5e7eb;
    --border-color-light: #f3f4f6;
    
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.1);
    --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    
    /* Button colors */
    --btn-primary-bg: #3b82f6;
    --btn-primary-hover: #2563eb;
    --btn-secondary-bg: #6b7280;
    --btn-secondary-hover: #4b5563;
    
    /* Status colors */
    --color-success: #10b981;
    --color-success-bg: #d1fae5;
    --color-success-text: #065f46;
    
    --color-error: #ef4444;
    --color-error-bg: #fee2e2;
    --color-error-text: #991b1b;
    
    --color-warning: #f59e0b;
    --color-warning-bg: #fef3c7;
    --color-warning-text: #92400e;
    
    --color-info: #3b82f6;
    --color-info-bg: #dbeafe;
    --color-info-text: #1e40af;
    
    /* Message colors */
    --msg-user-bg: #eff6ff;
    --msg-user-border: #3b82f6;
    --msg-assistant-bg: #ffffff;
    --msg-assistant-border: #10b981;
    --msg-assistant-response-bg: #f0fdf4;
    --msg-assistant-response-border: #86efac;
    --msg-system-bg: #f3f4f6;
    --msg-system-border: #9ca3af;
    --msg-tool-use-bg: #fef3c7;
    --msg-tool-use-border: #f59e0b;
    --msg-tool-result-bg: #f3e8ff;
    --msg-tool-result-border: #9333ea;
    
    /* Code block colors */
    --code-bg: #1e293b;
    --code-text: #e2e8f0;
  }
  
  /* Dark theme */
  [data-theme="dark"] {
    --bg-primary: #0f172a;
    --bg-secondary: #1e293b;
    --bg-tertiary: #334155;
    --bg-dark-section: #020617;
    
    --text-primary: #f1f5f9;
    --text-secondary: #cbd5e1;
    --text-tertiary: #94a3b8;
    --text-link: #60a5fa;
    --text-link-hover: #93bbfc;
    
    --border-color: #334155;
    --border-color-light: #1e293b;
    
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
    
    /* Button colors */
    --btn-primary-bg: #2563eb;
    --btn-primary-hover: #3b82f6;
    --btn-secondary-bg: #475569;
    --btn-secondary-hover: #64748b;
    
    /* Status colors */
    --color-success: #10b981;
    --color-success-bg: #064e3b;
    --color-success-text: #6ee7b7;
    
    --color-error: #ef4444;
    --color-error-bg: #7f1d1d;
    --color-error-text: #fca5a5;
    
    --color-warning: #f59e0b;
    --color-warning-bg: #78350f;
    --color-warning-text: #fde68a;
    
    --color-info: #3b82f6;
    --color-info-bg: #1e3a8a;
    --color-info-text: #93bbfc;
    
    /* Message colors */
    --msg-user-bg: #1e3a8a;
    --msg-user-border: #3b82f6;
    --msg-assistant-bg: #1e293b;
    --msg-assistant-border: #10b981;
    --msg-assistant-response-bg: #064e3b;
    --msg-assistant-response-border: #34d399;
    --msg-system-bg: #374151;
    --msg-system-border: #6b7280;
    --msg-tool-use-bg: #78350f;
    --msg-tool-use-border: #f59e0b;
    --msg-tool-result-bg: #4c1d95;
    --msg-tool-result-border: #9333ea;
    
    /* Code block colors */
    --code-bg: #0f172a;
    --code-text: #e2e8f0;
  }
  
  * {
    box-sizing: border-box;
  }
  
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-primary);
    background-color: var(--bg-primary);
    transition: background-color 0.3s ease, color 0.3s ease;
  }
  .container {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 1rem;
  }
  nav {
    background: var(--bg-secondary);
    box-shadow: var(--shadow-sm);
    border-bottom: 1px solid var(--border-color);
  }
  nav .container {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
  }
  h3 {
    font-size: 1.125rem;
    font-weight: 500;
    margin: 0 0 1rem 0;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .stat-card {
    background: var(--bg-secondary);
    padding: 1.5rem;
    border-radius: 0.5rem;
    box-shadow: var(--shadow-sm);
  }
  .stat-label {
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0.5rem 0;
  }
  .stat-meta {
    font-size: 0.75rem;
    color: var(--text-tertiary);
  }

  .section {
    background: var(--bg-secondary);
    border-radius: 0.5rem;
    box-shadow: var(--shadow-sm);
    margin-bottom: 1.5rem;
  }
  .section-header {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
    font-weight: 500;
  }
  .section-content {
    padding: 1.5rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    padding: 0.75rem;
    border-bottom: 1px solid var(--border-color);
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border-color-light);
  }
  tr:hover {
    background-color: var(--bg-tertiary);
  }

  .btn {
    display: inline-block;
    padding: 0.5rem 1rem;
    background: var(--btn-primary-bg);
    color: white;
    text-decoration: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    border: none;
    cursor: pointer;
  }
  .btn:hover {
    background: var(--btn-primary-hover);
  }
  .btn-secondary {
    background: var(--btn-secondary-bg);
  }
  .btn-secondary:hover {
    background: var(--btn-secondary-hover);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn:disabled:hover {
    background: var(--btn-primary-bg);
  }
  .btn-secondary:disabled:hover {
    background: var(--btn-secondary-bg);
  }

  select {
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    font-size: 1rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* Pagination styles */
  .pagination-link {
    padding: 0.5rem 0.75rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    text-decoration: none;
    color: #374151;
    transition: all 0.15s;
  }
  .pagination-link:hover {
    background: #f3f4f6;
    border-color: #d1d5db;
  }
  .pagination-current {
    padding: 0.5rem 0.75rem;
    background: #3b82f6;
    color: white;
    border-radius: 0.375rem;
  }
  .pagination-disabled {
    padding: 0.5rem 1rem;
    color: #9ca3af;
  }

  .text-sm {
    font-size: 0.875rem;
  }
  .text-gray-500 {
    color: #6b7280;
  }
  .text-gray-600 {
    color: #4b5563;
  }
  .text-blue-600 {
    color: #2563eb;
  }
  .mb-6 {
    margin-bottom: 1.5rem;
  }
  .space-x-4 > * + * {
    margin-left: 1rem;
  }

  .error-banner {
    background: #fee;
    border: 1px solid #fcc;
    color: #c33;
    padding: 1rem;
    margin-bottom: 1rem;
    border-radius: 0.375rem;
  }

  /* Conversation view styles */
  .conversation-container {
    max-width: 1200px;
    margin: 0 auto;
  }

  .message {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .message-index {
    flex-shrink: 0;
    width: 30px;
    padding-top: 0.5rem;
    text-align: center;
    font-size: 0.75rem;
    color: #9ca3af;
    font-weight: 500;
  }

  .message-meta {
    flex-shrink: 0;
    width: 80px;
    padding-top: 0.5rem;
    text-align: right;
    font-size: 0.75rem;
    color: #6b7280;
  }

  .message-content {
    flex: 1;
    min-width: 0;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: #f9fafb;
    border-left: 4px solid #e5e7eb;
    position: relative;
  }

  .message-user .message-content {
    background: #eff6ff;
    border-left-color: #3b82f6;
  }

  .message-assistant .message-content {
    background: white;
    border: 1px solid #e5e7eb;
    border-left: 4px solid #10b981;
  }

  .message-system .message-content {
    background: var(--msg-system-bg);
    border: 1px solid var(--msg-system-border);
    border-left: 4px solid var(--msg-system-border);
  }

  /* Special styling for assistant responses in request details */
  .message-assistant-response .message-content {
    background: #f0fdf4;
    border: 2px solid #86efac;
    border-left: 6px solid #10b981;
    box-shadow: 0 2px 4px rgba(16, 185, 129, 0.1);
  }

  .message-text {
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  /* Code blocks in messages */
  .message-content pre {
    margin: 0.5rem 0;
    padding: 0.75rem;
    border-radius: 0.375rem;
    overflow-x: auto;
  }

  .message-content code {
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-size: 0.875em;
    font-family: monospace;
  }

  .message-content pre code {
    padding: 0;
    font-size: 0.875rem;
  }

  /* Message role and time styles */
  .message-role {
    font-weight: 600;
    margin-top: 0.25rem;
  }

  /* Message actions container */
  .message-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
    margin-left: auto;
  }

  /* Navigation arrows container */
  .nav-arrows-container {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  /* Navigation arrows for user messages */
  .nav-arrow {
    background: none;
    border: none;
    padding: 0.125rem;
    cursor: pointer;
    color: var(--text-secondary);
    transition: color 0.2s;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nav-arrow:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .nav-arrow:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .nav-arrow svg {
    display: block;
  }

  /* Hide tools feature */
  .hide-tools .message-tool-use .message-content,
  .hide-tools .message-tool-result .message-content {
    max-height: 2rem;
    overflow: hidden;
    position: relative;
    opacity: 0.6;
    display: flex;
    align-items: center;
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }

  /* Hide truncation elements in collapsed tool messages */
  .hide-tools .message-tool-use .message-truncated,
  .hide-tools .message-tool-result .message-truncated {
    display: none;
  }

  /* Hide full content divs in collapsed tool messages */
  .hide-tools .message-tool-use .message-content > div[id^="content-"],
  .hide-tools .message-tool-result .message-content > div[id^="content-"] {
    display: none !important;
  }

  /* Hide pre elements in collapsed tool messages */
  .hide-tools .message-tool-use .message-content pre,
  .hide-tools .message-tool-result .message-content pre {
    display: none;
  }


  .hide-tools .message-tool-use .message-content {
    background: var(--msg-tool-use-bg);
  }

  .hide-tools .message-tool-result .message-content {
    background: var(--msg-tool-result-bg);
  }

  /* Hide copy button for collapsed tool messages */
  .hide-tools .message-tool-use .copy-message-link,
  .hide-tools .message-tool-result .copy-message-link {
    display: none;
  }

  /* Tool name label for collapsed messages */
  .tool-name-label {
    font-weight: 600;
    color: var(--color-warning-text);
    margin-right: 0.5rem;
    display: inline-block;
    line-height: 1;
  }

  .message-time {
    font-size: 0.675rem;
    color: var(--text-tertiary);
  }

  /* Tool message styles */
  .message-tool-use .message-content {
    background: var(--msg-tool-use-bg);
    border: 1px solid var(--msg-tool-use-border);
    border-left: 4px solid var(--msg-tool-use-border);
  }

  .message-tool-result .message-content {
    background: var(--msg-tool-result-bg);
    border: 1px solid var(--msg-tool-result-border);
    border-left: 4px solid var(--msg-tool-result-border);
  }

  /* Copy link button */
  .copy-message-link {
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 0.25rem;
    margin-top: 0.25rem;
    transition: color 0.2s;
  }

  .copy-message-link:hover {
    color: var(--text-secondary);
  }

  /* Tool call styles */
  .tool-calls {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-color);
  }
  
  .tool-call {
    margin-bottom: 0.5rem;
    padding: 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  
  .tool-name {
    font-weight: 600;
    color: var(--color-success);
    margin-bottom: 0.25rem;
  }
  
  .tool-params {
    background: var(--bg-primary);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-family: monospace;
    font-size: 0.7rem;
    overflow-x: auto;
  }

  /* Request details styles */
  .detail-grid {
    display: grid;
    gap: 1.5rem;
  }

  .detail-group {
    background: var(--bg-secondary);
    padding: 1.5rem;
    border-radius: 0.5rem;
    box-shadow: var(--shadow-sm);
  }

  .detail-item {
    margin-bottom: 1rem;
  }

  .detail-label {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-bottom: 0.25rem;
  }

  .detail-value {
    font-size: 1rem;
    font-weight: 500;
  }

  /* Token usage styles */
  .usage-chart {
    height: 300px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    padding: 1rem;
    margin-bottom: 2rem;
  }

  .usage-bar {
    height: 40px;
    background: var(--bg-tertiary);
    border-radius: 0.5rem;
    overflow: hidden;
    position: relative;
    margin: 1rem 0;
  }

  .usage-fill {
    height: 100%;
    background: var(--btn-primary-bg);
    transition: width 0.3s ease;
  }

  .usage-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  /* Form styles */
  .login-container {
    max-width: 400px;
    margin: 4rem auto;
    padding: 2rem;
    background: var(--bg-secondary);
    border-radius: 0.5rem;
    box-shadow: var(--shadow-sm);
  }

  .form-group {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
  }

  input[type="text"],
  input[type="password"] {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    font-size: 1rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  input[type="text"]:focus,
  input[type="password"]:focus {
    outline: none;
    border-color: var(--btn-primary-bg);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  /* Search styles */
  .search-box {
    position: relative;
    margin-bottom: 1rem;
  }

  .search-input {
    width: 100%;
    padding: 0.75rem 1rem;
    padding-left: 2.5rem;
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    font-size: 0.875rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .search-icon {
    position: absolute;
    left: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-tertiary);
  }

  /* View toggle styles */
  .view-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 1rem 0;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 0;
  }

  .view-toggle button {
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-secondary);
    transition: all 0.2s;
  }

  .view-toggle button:hover {
    color: var(--text-primary);
  }

  .view-toggle button.active {
    color: var(--btn-primary-bg);
    border-bottom-color: var(--btn-primary-bg);
  }

  /* Cost info styles */
  .cost-info {
    display: inline-flex;
    gap: 0.75rem;
    color: var(--text-secondary);
  }

  .cost-info span {
    white-space: nowrap;
  }

  /* Message truncation styles */
  .message-truncated {
    position: relative;
  }

  .show-more-btn {
    color: var(--text-link);
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    margin-left: 0.5rem;
    text-decoration: underline;
  }

  .show-more-btn:hover {
    color: var(--text-link-hover);
  }

  /* Utility classes */
  .text-right {
    text-align: right;
  }

  .text-center {
    text-align: center;
  }

  .font-mono {
    font-family: monospace;
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hidden {
    display: none !important;
  }

  .flex {
    display: flex;
  }

  /* Conversation detail styles */
  .conversation-stats-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin-bottom: 1.5rem;
    background: var(--bg-secondary);
    border-radius: 0.5rem;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .conversation-stat-card {
    flex: 1 1 auto;
    min-width: 140px;
    padding: 0.875rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-right: 1px solid var(--border-color);
  }

  .conversation-stat-card:last-child {
    border-right: none;
  }

  .conversation-stat-label {
    font-size: 0.875rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .conversation-stat-value {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-left: auto;
  }

  @media (max-width: 768px) {
    .conversation-stats-grid {
      flex-direction: column;
    }
    
    .conversation-stat-card {
      border-right: none;
      border-bottom: 1px solid var(--border-color);
      min-width: 100%;
    }
    
    .conversation-stat-card:last-child {
      border-bottom: none;
    }
  }

  /* Branch filter styles */
  .branch-filter {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 2rem;
    flex-wrap: wrap;
  }

  .branch-chip {
    display: inline-block;
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    border-radius: 9999px;
    text-decoration: none;
    transition: all 0.2s;
    border: 1px solid;
    font-weight: 500;
  }

  .branch-chip:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .branch-chip-active {
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
  }

  /* Conversation graph container */
  .conversation-graph-container {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 2rem;
    margin-top: 2rem;
  }

  .conversation-graph {
    background: var(--bg-secondary);
    padding: 1.5rem;
    border-radius: 0.5rem;
    box-shadow: var(--shadow-sm);
    position: sticky;
    top: 1rem;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
  }
  
  /* Panning styles for tree view */
  #tree-panel {
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
  }
  
  #tree-panel:active {
    cursor: grabbing !important;
  }
  
  #tree-container {
    transition: none;
  }

  .conversation-timeline {
    min-width: 0;
  }

  /* Responsive layout */
  @media (max-width: 1024px) {
    .conversation-graph-container {
      grid-template-columns: 1fr;
    }
    
    .conversation-graph {
      position: static;
      max-height: 500px;
    }
  }

  .items-center {
    align-items: center;
  }

  .justify-between {
    justify-content: space-between;
  }

  .gap-2 {
    gap: 0.5rem;
  }

  .gap-4 {
    gap: 1rem;
  }

  /* Responsive styles */
  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }
    
    nav .container {
      flex-direction: column;
      gap: 1rem;
      text-align: center;
    }
    
    .message-meta {
      display: none;
    }
    
    table {
      font-size: 0.75rem;
    }
    
    th, td {
      padding: 0.5rem;
    }
  }

  /* Loading spinner */
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 3px solid rgba(59, 130, 246, 0.3);
    border-radius: 50%;
    border-top-color: var(--btn-primary-bg);
    animation: spin 1s ease-in-out infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Code block styles */
  pre {
    background: var(--code-bg);
    color: var(--code-text);
    padding: 1rem;
    border-radius: 0.375rem;
    overflow-x: auto;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  code {
    font-family: 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace;
  }

  /* Status badges */
  .badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 0.25rem;
  }

  .badge-success {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }

  .badge-error {
    background: var(--color-error-bg);
    color: var(--color-error-text);
  }

  .badge-warning {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }

  .badge-info {
    background: var(--color-info-bg);
    color: var(--color-info-text);
  }

  /* Tool result images styling */
  .tool-result-image {
    display: block;
    max-width: 100%;
    max-height: 600px;
    height: auto;
    margin: 0.75rem 0;
    border-radius: 0.5rem;
    border: 1px solid var(--border-color);
    box-shadow: var(--shadow-sm);
    background-color: var(--bg-tertiary);
    object-fit: contain;
  }

  /* Add hover effect for images */
  .tool-result-image:hover {
    box-shadow: var(--shadow-md);
    cursor: zoom-in;
  }

  /* Ensure images don't break out of their containers */
  .message-content img {
    max-width: 100%;
    height: auto;
  }

  /* Thumbnail version for truncated messages */
  .tool-result-image-thumbnail {
    width: 120px !important;
    height: 90px !important;
    cursor: pointer;
    opacity: 0.9;
    transition: opacity 0.2s ease;
    display: inline-block;
    margin-right: 0.5rem;
    object-fit: cover;
  }

  .tool-result-image-thumbnail:hover {
    opacity: 1;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.15);
  }

  /* Lightbox overlay for image viewing */
  .image-lightbox {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    cursor: zoom-out;
    padding: 2rem;
  }

  .image-lightbox img {
    max-width: 90%;
    max-height: 90%;
    object-fit: contain;
    box-shadow: 0 0 50px rgba(0, 0, 0, 0.5);
    border-radius: 0.5rem;
    cursor: default;
  }

  .image-lightbox-close {
    position: absolute;
    top: 2rem;
    right: 2rem;
    color: white;
    font-size: 2rem;
    font-weight: 300;
    cursor: pointer;
    background: none;
    border: none;
    padding: 0.5rem;
    line-height: 1;
    opacity: 0.8;
    transition: opacity 0.2s;
  }

  .image-lightbox-close:hover {
    opacity: 1;
  }

  /* MCP Prompts Styles */
  .prompts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
    margin-top: 2rem;
  }

  .prompt-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1.5rem;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .prompt-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }

  .prompt-name {
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
    font-size: 1.1rem;
  }

  .prompt-description {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin: 0 0 1rem 0;
    line-height: 1.5;
  }

  .prompt-meta {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .prompt-id {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .prompt-args {
    background: var(--bg-tertiary);
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .prompt-actions {
    display: flex;
    gap: 0.5rem;
  }

  .sync-status {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 2rem;
  }

  .sync-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .status-label {
    font-weight: 500;
    color: var(--text-secondary);
  }

  .status-value {
    font-family: var(--font-mono);
  }

  .status-value.success {
    color: var(--color-success);
  }

  .status-value.error {
    color: var(--color-error);
  }

  .status-value.syncing {
    color: var(--color-warning);
  }

  .status-value.never_synced {
    color: var(--text-muted);
  }
  
  /* Read-only banner styles */
  .read-only-banner {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
    padding: 0.75rem 1rem;
    text-align: center;
    font-weight: 500;
    font-size: 0.875rem;
    border-bottom: 1px solid var(--color-warning);
  }

  /* Toast notification styles */
  #toast-container {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 1000;
  }
  
  .toast {
    background: var(--toast-bg);
    border: 1px solid var(--toast-border);
    border-radius: 0.5rem;
    padding: 1rem;
    margin-bottom: 0.5rem;
    max-width: 400px;
    box-shadow: var(--shadow-md);
    animation: slideIn 0.3s ease-out;
  }
  
  .toast-error {
    background: var(--color-error-bg);
    border-color: var(--color-error);
  }
  
  .toast-message {
    color: var(--toast-text);
    font-size: 0.875rem;
    font-weight: 500;
  }
  
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  /* Dark mode toggle styles */
  .theme-toggle {
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    padding: 0.5rem;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
  }
  
  .theme-toggle:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  
  .theme-toggle svg {
    width: 20px;
    height: 20px;
  }
  
  /* Dark mode specific code block adjustments */
  [data-theme="dark"] .message-content pre,
  [data-theme="dark"] .message-content code,
  [data-theme="dark"] .conversation-container pre,
  [data-theme="dark"] .conversation-container code {
    background-color: var(--code-bg) !important;
    color: var(--code-text) !important;
    border-color: var(--border-color);
  }
  
  [data-theme="dark"] .hljs {
    background: transparent !important;
    color: var(--code-text) !important;
  }
`
