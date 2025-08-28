// Message selection functionality for Agent PromptTrain Dashboard

// 1. Hash parsing function
function parseMessageHash(hash) {
  // Input: "#messages-5" or "#messages-3-7"
  // Output: { start: 5, end: 5 } or { start: 3, end: 7 }
  // Return null if invalid format
  
  if (!hash || !hash.startsWith('#messages-')) {
    return null;
  }
  
  const parts = hash.substring('#messages-'.length).split('-');
  
  if (parts.length === 1) {
    const index = parseInt(parts[0], 10);
    if (isNaN(index) || index < 0) {
      return null;
    }
    return { start: index, end: index };
  } else if (parts.length === 2) {
    const start = parseInt(parts[0], 10);
    const end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end) || start < 0 || end < 0 || start > end) {
      return null;
    }
    return { start, end };
  }
  
  return null;
}

// 2. Apply selection to DOM
function highlightMessages(start, end) {
  // Remove all existing .message-selected classes
  const allMessages = document.querySelectorAll('.message');
  allMessages.forEach(msg => msg.classList.remove('message-selected'));
  
  // Add .message-selected to messages in range
  let found = false;
  for (let i = start; i <= end; i++) {
    const message = document.getElementById(`message-${i}`);
    if (message) {
      message.classList.add('message-selected');
      found = true;
    }
  }
  
  // Return true if messages were found
  return found;
}

// 3. Scroll to message
function scrollToMessage(index) {
  // Find element with id="message-{index}"
  const element = document.getElementById(`message-${index}`);
  if (element) {
    // Calculate offset from top (leave some space for navigation)
    const navHeight = document.querySelector('nav')?.offsetHeight || 0;
    const offset = navHeight + 20; // 20px additional padding
    
    // Get element position
    const elementTop = element.getBoundingClientRect().top + window.pageYOffset;
    
    // Smooth scroll with offset
    window.scrollTo({
      top: elementTop - offset,
      behavior: 'smooth'
    });
  }
}

// 4. Toast notification system
function showToast(message, duration = 3000) {
  // Create toast element
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  
  // Add to DOM
  document.body.appendChild(toast);
  
  // Auto-remove after duration
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => {
      toast.remove();
    }, 300); // Match animation duration
  }, duration);
}

// 5. Handle copy button clicks
function handleCopyClick(event) {
  // Get message index from data attribute
  const button = event.currentTarget;
  const messageIndex = button.dataset.messageIndex;
  
  if (!messageIndex) {
    return;
  }
  
  // Generate full URL with hash
  const url = `${window.location.origin}${window.location.pathname}#messages-${messageIndex}`;
  
  // Copy to clipboard
  navigator.clipboard.writeText(url).then(() => {
    showToast('Link copied to clipboard!');
  }).catch(err => {
    console.error('Failed to copy to clipboard:', err);
    showToast('Failed to copy link');
  });
}

// 6. Handle message selection clicks
let lastSelectedIndex = null;

function handleMessageClick(event) {
  // Check if the click was on the copy button
  if (event.target.closest('.copy-message-link')) {
    return; // Let the copy button handler deal with it
  }
  
  // Check if the click was on a link or interactive element
  if (event.target.tagName === 'A' || event.target.tagName === 'BUTTON') {
    return;
  }
  
  const messageEl = event.currentTarget;
  const index = parseInt(messageEl.dataset.messageIndex, 10);
  
  if (isNaN(index)) {
    return;
  }
  
  if (event.shiftKey && lastSelectedIndex !== null) {
    // Select range
    const start = Math.min(lastSelectedIndex, index);
    const end = Math.max(lastSelectedIndex, index);
    window.location.hash = `messages-${start}-${end}`;
  } else {
    // Select single
    window.location.hash = `messages-${index}`;
    lastSelectedIndex = index;
  }
}

// 7. Handle hash changes
function handleHashChange() {
  const parsed = parseMessageHash(window.location.hash);
  if (parsed) {
    const highlighted = highlightMessages(parsed.start, parsed.end);
    if (highlighted) {
      // Update lastSelectedIndex for shift+click functionality
      lastSelectedIndex = parsed.end;
    }
  } else {
    // Clear selection if hash is invalid or removed
    const allMessages = document.querySelectorAll('.message');
    allMessages.forEach(msg => msg.classList.remove('message-selected'));
    lastSelectedIndex = null;
  }
}

// 8. Initialize on page load
function initMessageSelection() {
  // Parse current hash
  const parsed = parseMessageHash(window.location.hash);
  if (parsed) {
    // Apply highlighting
    const highlighted = highlightMessages(parsed.start, parsed.end);
    if (highlighted) {
      // Scroll to first selected message after a short delay to ensure page is loaded
      setTimeout(() => {
        scrollToMessage(parsed.start);
      }, 100);
      // Update lastSelectedIndex
      lastSelectedIndex = parsed.end;
    }
  }
  
  // Set up event listeners
  
  // Copy button clicks
  const copyButtons = document.querySelectorAll('.copy-message-link');
  copyButtons.forEach(button => {
    button.addEventListener('click', handleCopyClick);
  });
  
  // Message clicks for selection
  const messages = document.querySelectorAll('.message');
  messages.forEach(message => {
    message.addEventListener('click', handleMessageClick);
  });
  
  // Hash change listener
  window.addEventListener('hashchange', handleHashChange);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMessageSelection);
} else {
  // DOM is already loaded
  initMessageSelection();
}