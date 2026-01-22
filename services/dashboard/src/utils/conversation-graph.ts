import { calculateSimpleLayout } from './simple-graph-layout.js'
import { getModelContextLimit, getBatteryColor } from '@agent-prompttrain/shared'

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface ConversationNode {
  id: string
  label: string
  displayName?: string // Sub-agent name or other display override
  timestamp: Date
  branchId: string
  parentId?: string
  tokens: number
  model: string
  hasError: boolean
  messageIndex?: number
  messageCount?: number
  toolCallCount?: number
  messageTypes?: string[]
  isSubtask?: boolean
  hasSubtasks?: boolean
  subtaskCount?: number
  linkedConversationId?: string
  subtaskPrompt?: string
  hasUserMessage?: boolean
  contextTokens?: number
  lastMessageType?: 'user' | 'assistant' | 'tool_result'
  toolResultStatus?: 'success' | 'error' | 'mixed'
}

export interface ConversationGraph {
  nodes: ConversationNode[]
  edges: Array<{ source: string; target: string }>
}

export interface LayoutNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  branchId: string
  timestamp: Date
  label: string
  displayName?: string // Sub-agent name or other display override
  tokens: number
  model: string
  hasError: boolean
  messageIndex?: number
  messageCount?: number
  toolCallCount?: number
  messageTypes?: string[]
  isSubtask?: boolean
  hasSubtasks?: boolean
  subtaskCount?: number
  linkedConversationId?: string
  subtaskPrompt?: string
  hasUserMessage?: boolean
  contextTokens?: number
  lastMessageType?: 'user' | 'assistant' | 'tool_result'
  toolResultStatus?: 'success' | 'error' | 'mixed'
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  sections: Array<{
    startPoint: { x: number; y: number }
    endPoint: { x: number; y: number }
    bendPoints?: Array<{ x: number; y: number }>
  }>
}

export interface GraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
}

/**
 * Calculate the layout for a conversation graph
 */
export async function calculateGraphLayout(
  graph: ConversationGraph,
  reversed: boolean = false,
  _requestMap?: Map<string, any>
): Promise<GraphLayout> {
  if (reversed) {
    // For reversed layout, we need a custom approach
    return calculateReversedLayout(graph, _requestMap)
  }

  // Use the simple layout algorithm
  return calculateSimpleLayout(graph)
}

/**
 * Calculate layout for reversed tree (newest at top)
 */
function calculateReversedLayout(
  graph: ConversationGraph,
  _requestMap?: Map<string, any>
): GraphLayout {
  const nodeWidth = 160
  const nodeHeight = 32
  const subtaskNodeWidth = 100
  const subtaskNodeHeight = 36
  const horizontalSpacing = 180
  const verticalSpacing = 30
  const subtaskOffset = 180 // How far to the right sub-task nodes should be

  // Build parent-child relationships for branch detection
  const childrenMap = new Map<string | undefined, string[]>()
  const nodeMap = new Map<string, (typeof graph.nodes)[0]>()

  graph.nodes.forEach(node => {
    nodeMap.set(node.id, node)
    const children = childrenMap.get(node.parentId) || []
    children.push(node.id)
    childrenMap.set(node.parentId, children)
  })

  // Track branch lanes with column availability
  const branchLanes = new Map<string, number>()
  // Track column availability: each column stores the lowest Y position occupied (busy until)
  // Since tree is reversed (lower Y = higher up), a column is available if its value < branch's maxY
  const columnAvailability: number[] = [] // Array index = column, value = lowest Y occupied

  // Helper to find first available column for a branch
  // Since Y coordinates are reversed (lower Y = higher position), we check if column is free at the top of the branch
  function findAvailableColumn(maxY: number): number {
    for (let col = 0; col < columnAvailability.length; col++) {
      // A column is available if its lowest occupied Y is greater than the branch's highest Y (with some buffer)
      if (columnAvailability[col] > maxY) {
        return col
      }
    }
    // If no existing column is available, create a new one
    return columnAvailability.length
  }

  // Build a map of node distances from root
  const nodeDistances = new Map<string, number>()

  // Helper function to calculate distance from root
  function calculateDistance(nodeId: string, visited = new Set<string>()): number {
    if (visited.has(nodeId)) {
      return 0
    } // Prevent cycles
    visited.add(nodeId)

    const cached = nodeDistances.get(nodeId)
    if (cached !== undefined) {
      return cached
    }

    const node = nodeMap.get(nodeId)
    if (!node || !node.parentId) {
      // Root node or no parent
      nodeDistances.set(nodeId, node?.messageCount || 1)
      return node?.messageCount || 1
    }

    // Calculate parent's distance first
    const parentDistance = calculateDistance(node.parentId, visited)
    const distance = parentDistance + 1
    nodeDistances.set(nodeId, distance)
    return distance
  }

  // Calculate distances for all nodes
  graph.nodes.forEach(node => {
    if (!node.id.endsWith('-subtasks')) {
      calculateDistance(node.id)
    }
  })

  // Find max distance for positioning
  const maxDistance = Math.max(...Array.from(nodeDistances.values()), 0)

  // First pass: position regular nodes
  const layoutNodes: LayoutNode[] = []
  const subtaskNodes: typeof graph.nodes = []

  // Create a map to track actual Y positions for each node
  const nodeYPositions = new Map<string, number>()

  // First, calculate Y positions for all non-subtask nodes
  const nodeYData: Array<{ node: ConversationNode; y: number }> = []
  graph.nodes.forEach(node => {
    if (!node.id.endsWith('-subtasks')) {
      const distance = nodeDistances.get(node.id) || node.messageCount || 0
      const y = (maxDistance - distance) * verticalSpacing
      nodeYPositions.set(node.id, y)
      nodeYData.push({ node, y })
    }
  })

  // Sort nodes by Y position (bottom to top) to assign columns optimally
  nodeYData.sort((a, b) => b.y - a.y)

  // Track which Y ranges each branch occupies
  const branchYRanges = new Map<string, { minY: number; maxY: number }>()

  // Calculate Y ranges for each branch
  nodeYData.forEach(({ node, y }) => {
    const range = branchYRanges.get(node.branchId) || { minY: y, maxY: y }
    range.minY = Math.min(range.minY, y)
    range.maxY = Math.max(range.maxY, y)
    branchYRanges.set(node.branchId, range)
  })

  // Sort branches by their maximum Y position (bottom to top) for optimal column assignment
  // Higher maxY values = branches that start lower in the tree (should be processed first)
  const branchesInOrder = Array.from(branchYRanges.entries())
    .sort((a, b) => b[1].maxY - a[1].maxY)
    .map(([branchId]) => branchId)

  // Assign columns to branches in order
  branchesInOrder.forEach(branchId => {
    const branchRange = branchYRanges.get(branchId)
    if (branchRange) {
      // Find available column for this branch (check if column is free at the top of the branch)
      const column = findAvailableColumn(branchRange.maxY)
      branchLanes.set(branchId, column)

      // Mark column as busy down to the bottom of this branch
      // Since lower Y = higher position, we store minY as the "busy until" value
      // Subtract nodeHeight to add some spacing between branches
      const busyUntil = branchRange.minY - nodeHeight
      if (column >= columnAvailability.length) {
        columnAvailability.push(busyUntil)
      } else {
        columnAvailability[column] = Math.min(columnAvailability[column], busyUntil)
      }
    }
  })

  // Separate regular nodes and subtask nodes
  graph.nodes.forEach(node => {
    if (node.id.endsWith('-subtasks')) {
      subtaskNodes.push(node)
    } else {
      // Process regular nodes - lane is already assigned
      const lane = branchLanes.get(node.branchId) || 0

      // Use the pre-calculated distance for positioning
      const distance = nodeDistances.get(node.id) || node.messageCount || 0

      // Y position is based on reversed distance (newest at top)
      const y = (maxDistance - distance) * verticalSpacing

      // X position is based on branch lane
      const x = lane * horizontalSpacing

      layoutNodes.push({
        id: node.id,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        branchId: node.branchId,
        timestamp: node.timestamp,
        label: node.label,
        displayName: node.displayName,
        tokens: node.tokens,
        model: node.model,
        hasError: node.hasError,
        messageIndex: node.messageIndex,
        messageCount: node.messageCount,
        toolCallCount: node.toolCallCount,
        messageTypes: node.messageTypes,
        isSubtask: node.isSubtask,
        hasSubtasks: node.hasSubtasks,
        subtaskCount: node.subtaskCount,
        linkedConversationId: node.linkedConversationId,
        subtaskPrompt: node.subtaskPrompt,
        hasUserMessage: node.hasUserMessage,
        contextTokens: node.contextTokens,
        lastMessageType: node.lastMessageType,
        toolResultStatus: node.toolResultStatus,
      })
    }
  })

  // Second pass: position subtask nodes
  subtaskNodes.forEach(node => {
    const parentId = node.parentId
    const parentNode = graph.nodes.find(n => n.id === parentId)
    if (parentNode) {
      const parentLane = branchLanes.get(parentNode.branchId) || 0

      // Use the actual Y position we calculated for the parent
      const parentY = parentId ? nodeYPositions.get(parentId) || 0 : 0

      // Count how many subtask nodes are already positioned for this parent
      const _existingSubtaskNodes = layoutNodes.filter(
        ln =>
          ln.id.endsWith('-subtasks') &&
          subtaskNodes.find(n => n.id === ln.id)?.parentId === parentId
      ).length

      layoutNodes.push({
        id: node.id,
        x: parentLane * horizontalSpacing + subtaskOffset,
        y: parentY, // Align exactly with parent Y
        width: subtaskNodeWidth,
        height: subtaskNodeHeight,
        branchId: node.branchId,
        timestamp: node.timestamp,
        label: node.label,
        displayName: node.displayName,
        tokens: node.tokens,
        model: node.model,
        hasError: node.hasError,
        messageIndex: node.messageIndex,
        messageCount: node.messageCount,
        toolCallCount: node.toolCallCount,
        messageTypes: node.messageTypes,
        isSubtask: node.isSubtask,
        hasSubtasks: node.hasSubtasks,
        subtaskCount: node.subtaskCount,
        linkedConversationId: node.linkedConversationId,
        subtaskPrompt: node.subtaskPrompt,
        hasUserMessage: node.hasUserMessage,
        contextTokens: node.contextTokens,
        lastMessageType: node.lastMessageType,
        toolResultStatus: node.toolResultStatus,
      })
    }
  })

  // Create edges
  const layoutEdges: LayoutEdge[] = []
  graph.edges.forEach((edge, idx) => {
    const sourceNode = layoutNodes.find(n => n.id === edge.source)
    const targetNode = layoutNodes.find(n => n.id === edge.target)

    if (sourceNode && targetNode) {
      // Check if this is an edge to a sub-task summary node
      const isToSubtask = targetNode.id.endsWith('-subtasks')

      if (isToSubtask) {
        // For edges to sub-task nodes, draw from the right side of parent to left side of sub-task
        const startX = sourceNode.x + sourceNode.width
        const startY = sourceNode.y + sourceNode.height / 2
        const endX = targetNode.x
        const endY = targetNode.y + targetNode.height / 2
        const midX = startX + (endX - startX) / 2

        layoutEdges.push({
          id: `e${idx}`,
          source: edge.source,
          target: edge.target,
          sections: [
            {
              startPoint: { x: startX, y: startY },
              endPoint: { x: endX, y: endY },
              bendPoints: [
                { x: midX, y: startY },
                { x: midX, y: endY },
              ],
            },
          ],
        })
      } else {
        // Check if this is a branch connection
        const isBranchConnection = sourceNode.branchId !== targetNode.branchId

        if (isBranchConnection) {
          // Check if target is a normal branch (not compact or subtask)
          const isNormalBranch =
            !targetNode.branchId.startsWith('compact_') &&
            !targetNode.branchId.startsWith('subtask_')

          if (isNormalBranch) {
            // For normal branches, connect from source side to target bottom
            const sourceX =
              sourceNode.x < targetNode.x
                ? sourceNode.x + sourceNode.width // Right side of source
                : sourceNode.x // Left side of source
            const sourceY = sourceNode.y + sourceNode.height / 3
            const targetX = targetNode.x + targetNode.width / 2
            const targetY = targetNode.y + targetNode.height

            // Create path that goes horizontal, then vertical, then to center bottom
            const bendX = targetX

            layoutEdges.push({
              id: `e${idx}`,
              source: edge.source,
              target: edge.target,
              sections: [
                {
                  startPoint: { x: sourceX, y: sourceY },
                  endPoint: { x: targetX, y: targetY },
                  bendPoints: [
                    { x: bendX, y: sourceY }, // Go horizontally
                    { x: bendX, y: targetY }, // Go vertically to target bottom
                  ],
                },
              ],
            })
          } else {
            // For compact/subtask branches, use side anchors
            const sourceX =
              sourceNode.x < targetNode.x
                ? sourceNode.x + sourceNode.width // Right side of source
                : sourceNode.x // Left side of source
            const targetX =
              sourceNode.x < targetNode.x
                ? targetNode.x // Left side of target
                : targetNode.x + targetNode.width // Right side of target

            const sourceY = sourceNode.y + sourceNode.height / 3
            const targetY = targetNode.y + (targetNode.height * 2) / 3

            // Create a path that goes horizontal first, then vertical, then horizontal again
            const horizontalOffset = 10 // Distance to travel horizontally before going vertical

            const bendX =
              targetNode.x > sourceNode.x ? targetX - horizontalOffset : targetX + horizontalOffset

            layoutEdges.push({
              id: `e${idx}`,
              source: edge.source,
              target: edge.target,
              sections: [
                {
                  startPoint: { x: sourceX, y: sourceY },
                  endPoint: { x: targetX, y: targetY },
                  bendPoints: [
                    { x: bendX, y: sourceY }, // Go horizontally to middle
                    { x: bendX, y: targetY }, // Go vertically to target height
                  ],
                },
              ],
            })
          }
        } else {
          // For same-branch connections, connect from bottom to top center
          layoutEdges.push({
            id: `e${idx}`,
            source: edge.source,
            target: edge.target,
            sections: [
              {
                startPoint: {
                  x: sourceNode.x + sourceNode.width / 2,
                  y: sourceNode.y, // Top of source (parent/older)
                },
                endPoint: {
                  x: targetNode.x + targetNode.width / 2,
                  y: targetNode.y + targetNode.height, // Bottom of target (child/newer)
                },
              },
            ],
          })
        }
      }
    }
  })

  // Calculate bounds
  const minX = Math.min(...layoutNodes.map(n => n.x))
  const maxX = Math.max(...layoutNodes.map(n => n.x + n.width))
  const minY = Math.min(...layoutNodes.map(n => n.y))
  const maxY = Math.max(...layoutNodes.map(n => n.y + n.height))

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: maxX - minX + 100,
    height: maxY - minY + 100,
  }
}

/**
 * Generate branch colors consistently
 */
export function getBranchColor(branchId: string): string {
  if (branchId === 'main') {
    return '#6b7280' // gray-500
  }

  // Generate a color based on the branch ID hash
  const colors = [
    '#3b82f6', // blue-500
    '#10b981', // green-500
    '#8b5cf6', // purple-500
    '#f59e0b', // amber-500
    '#ef4444', // red-500
    '#06b6d4', // cyan-500
    '#f97316', // orange-500
    '#ec4899', // pink-500
  ]

  let hash = 0
  for (let i = 0; i < branchId.length; i++) {
    hash = (hash << 5) - hash + branchId.charCodeAt(i)
    hash = hash & hash // Convert to 32-bit integer
  }

  return colors[Math.abs(hash) % colors.length]
}

/**
 * Render the conversation graph as SVG
 */
export function renderGraphSVG(layout: GraphLayout, interactive: boolean = true): string {
  const padding = 40
  const nodeRadius = 8
  const width = layout.width + padding * 2
  const height = layout.height + padding * 2

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`

  // Collect patterns needed for mixed tool results
  const patternsNeeded = new Set<string>()
  layout.nodes.forEach(node => {
    if (node.lastMessageType === 'tool_result' && node.toolResultStatus === 'mixed') {
      patternsNeeded.add(node.id)
    }
  })

  // Add CSS styles and patterns
  svg += `<defs>
    <style>
      .graph-edge { stroke: #e5e7eb; stroke-width: 2; fill: none; }
      .graph-node { stroke-width: 2; }
      .graph-node-main { fill: #6b7280; stroke: #4b5563; }
      .graph-node-branch { stroke: #3b82f6; }
      .graph-node-error { fill: #ef4444; stroke: #dc2626; }
      .graph-node-label { font-size: 10px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      .graph-node-clickable { cursor: pointer; }
      .graph-node-clickable:hover { opacity: 0.8; }
      .subtask-tooltip { display: none; }
      .subtask-group:hover .subtask-tooltip { display: block; }
    </style>\n`

  // Add patterns for mixed status nodes
  patternsNeeded.forEach(nodeId => {
    const patternId = `stripe-pattern-${nodeId.replace(/[^a-zA-Z0-9]/g, '-')}`
    svg += `    <pattern id="${patternId}" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
      <rect width="5" height="10" fill="#ecfdf5" />
      <rect x="5" width="5" height="10" fill="#fee2e2" />
    </pattern>\n`
  })

  svg += `  </defs>\n`

  // Render edges
  svg += '<g class="graph-edges">\n'
  for (const edge of layout.edges) {
    // Find the source and target nodes to check if this is a branch divergence
    const sourceNode = layout.nodes.find(n => n.id === edge.source)
    const targetNode = layout.nodes.find(n => n.id === edge.target)
    const isBranchDiverging =
      sourceNode && targetNode && sourceNode.branchId !== targetNode.branchId

    for (const section of edge.sections) {
      let path = ''
      const startX = section.startPoint.x + padding
      const startY = section.startPoint.y + padding
      const endX = section.endPoint.x + padding
      const endY = section.endPoint.y + padding

      if (section.bendPoints && section.bendPoints.length > 0) {
        // Use bend points for curved edges
        path = `M${startX},${startY}`
        section.bendPoints.forEach(bend => {
          path += ` L${bend.x + padding},${bend.y + padding}`
        })
        path += ` L${endX},${endY}`
      } else {
        // For regular edges, use straight line
        path = `M${startX},${startY} L${endX},${endY}`
      }

      // Check if this edge connects to a subtask branch
      const isToSubtask =
        targetNode && targetNode.branchId.startsWith('subtask_') && targetNode.messageCount === 1

      if (isToSubtask && targetNode) {
        // Draw edge with special styling for subtask connections
        const branchColor = getBranchColor(targetNode.branchId)
        svg += `  <path d="${path}" class="graph-edge" style="stroke: ${branchColor}; stroke-dasharray: 5,5;" />\n`
      } else if (isBranchDiverging && targetNode) {
        // For branch diverging edges, use target branch color
        const branchColor = getBranchColor(targetNode.branchId)
        svg += `  <path d="${path}" class="graph-edge" style="stroke: ${branchColor};" />\n`
      } else {
        svg += `  <path d="${path}" class="graph-edge" />\n`
      }
    }
  }
  svg += '</g>\n'

  // Pre-compute which nodes need anchors and on which sides
  const nodeAnchors = new Map<string, { left?: boolean; right?: boolean; bottom?: boolean }>()

  // Check each node if it's first in branch or spawns children
  layout.nodes.forEach(node => {
    const anchors: { left?: boolean; right?: boolean; bottom?: boolean } = {}

    // Check if this node is first in its branch (not main)
    if (node.branchId !== 'main' && node.messageCount === 1) {
      // Only add side anchors for compact and subtask branches
      if (node.branchId.startsWith('compact_') || node.branchId.startsWith('subtask_')) {
        // Find parent node to determine which side to anchor
        const parentEdge = layout.edges.find(e => e.target === node.id)
        if (parentEdge) {
          const parentNode = layout.nodes.find(n => n.id === parentEdge.source)
          if (parentNode && parentNode.x < node.x) {
            anchors.left = true
          } else if (parentNode && parentNode.x > node.x) {
            anchors.right = true
          }
        }
      }
    }

    // Check if this node spawns branches
    const childrenInOtherBranches = layout.edges
      .filter(e => e.source === node.id)
      .map(e => layout.nodes.find(n => n.id === e.target))
      .filter(child => child && child.branchId !== node.branchId)

    childrenInOtherBranches.forEach(child => {
      if (child && child.x > node.x) {
        anchors.right = true
      } else if (child && child.x < node.x) {
        anchors.left = true
      }
    })

    if (anchors.left || anchors.right) {
      nodeAnchors.set(node.id, anchors)
    }
  })

  // Render nodes
  svg += '<g class="graph-nodes">\n'

  // Collect tooltips to render them last
  let tooltips = ''

  for (const node of layout.nodes) {
    const x = node.x + padding
    const y = node.y + padding
    const color = getBranchColor(node.branchId)
    const nodeClass = node.hasError
      ? 'graph-node graph-node-error'
      : `graph-node ${node.branchId === 'main' ? 'graph-node-main' : 'graph-node-branch'}`

    // Check if this is a sub-task summary node
    const isSubtaskSummary = node.id.endsWith('-subtasks')

    if (isSubtaskSummary) {
      // Use foreignObject for better HTML tooltip support
      const tooltipId = `tooltip-${node.id.replace(/[^a-zA-Z0-9]/g, '-')}`

      svg += `  <g class="subtask-node-group">\n`

      // Render sub-task summary node with hover handler
      const hoverHandlers = node.subtaskPrompt
        ? ` onmouseover="document.querySelector('.${tooltipId}').style.display='block'" onmouseout="document.querySelector('.${tooltipId}').style.display='none'"`
        : ''

      // Make sub-task nodes clickable if they have a linked conversation
      if (interactive && node.linkedConversationId) {
        svg += `    <a href="/dashboard/conversation/${node.linkedConversationId}" style="cursor: pointer;">\n`
        svg += `      <rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="4" ry="4" class="graph-node graph-node-clickable" style="fill: #f3f4f6; stroke: #9ca3af; stroke-width: 1.5;"${hoverHandlers} />\n`
        svg += `      <text x="${x + node.width / 2}" y="${y + node.height / 2 + 4}" text-anchor="middle" class="graph-node-label" style="font-weight: 600; font-size: 12px; fill: #4b5563; pointer-events: none;">${node.label}</text>\n`
        svg += `    </a>\n`
      } else {
        svg += `      <rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="4" ry="4" class="graph-node" style="fill: #f3f4f6; stroke: #9ca3af; stroke-width: 1.5;"${hoverHandlers} />\n`
        svg += `      <text x="${x + node.width / 2}" y="${y + node.height / 2 + 4}" text-anchor="middle" class="graph-node-label" style="font-weight: 600; font-size: 12px; fill: #4b5563;">${node.label}</text>\n`
      }

      // Prepare tooltip to be rendered later
      if (node.subtaskPrompt) {
        const truncatedPrompt =
          node.subtaskPrompt.length > 250
            ? node.subtaskPrompt.substring(0, 250) + '...'
            : node.subtaskPrompt

        tooltips += `    <foreignObject x="${x - 75}" y="${y - 140}" width="250" height="130" style="display: none; z-index: 1000; pointer-events: none;" class="${tooltipId}">\n`
        tooltips += `      <div xmlns="http://www.w3.org/1999/xhtml" style="background: linear-gradient(135deg, #374151 0%, #1f2937 100%); border: 2px solid #6b7280; padding: 12px 14px; border-radius: 8px; font-size: 11px; line-height: 1.6; box-shadow: 0 6px 20px rgba(0,0,0,0.4); word-wrap: break-word; position: relative;">\n`
        tooltips += `        <div style="font-size: 10px; color: #9ca3af; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #4b5563; padding-bottom: 4px;">📋 Task Prompt</div>\n`
        tooltips += `        <div style="color: #e5e7eb; font-size: 11px;">${escapeHtml(truncatedPrompt)}</div>\n`
        tooltips += `        <div style="position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 8px solid #6b7280; border-bottom: 8px solid transparent;"></div>\n`
        tooltips += `        <div style="position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 6px solid #1f2937; border-bottom: 6px solid transparent;"></div>\n`
        tooltips += `      </div>\n`
        tooltips += `    </foreignObject>\n`
      }

      svg += `  </g>\n`
    } else {
      // Regular node rendering
      if (interactive) {
        svg += `  <a href="/dashboard/request/${node.id}">\n`
      }

      // Draw rectangle with rounded corners
      const strokeDasharray = node.branchId.startsWith('subtask_') ? 'stroke-dasharray: 8,2;' : ''

      // Determine background color based on message type and status
      let fillColor = 'white'

      if (node.lastMessageType === 'tool_result' && node.toolResultStatus) {
        if (node.toolResultStatus === 'success') {
          fillColor = '#ecfdf5' // green-50 (very light green)
        } else if (node.toolResultStatus === 'error') {
          fillColor = '#fee2e2' // red-100 (light red, more visible)
        } else if (node.toolResultStatus === 'mixed') {
          // Use the pattern ID for this node
          const patternId = `stripe-pattern-${node.id.replace(/[^a-zA-Z0-9]/g, '-')}`
          fillColor = `url(#${patternId})`
        }
      }
      // User messages stay white (default)

      svg += `    <rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="6" ry="6" class="${nodeClass}${interactive ? ' graph-node-clickable' : ''}" style="fill: ${fillColor}; stroke: ${node.hasError ? '#ef4444' : color}; stroke-width: 2; ${strokeDasharray}" />\n`

      // Add message count number on the left
      if (node.messageCount !== undefined && node.messageCount > 0) {
        svg += `    <text x="${x + 25}" y="${y + node.height / 2 + 3}" text-anchor="end" class="graph-node-label" style="font-weight: 700; font-size: 13px; fill: ${color};">${node.messageCount}</text>\n`
      }

      // Add appropriate icon based on branch type and user message
      let showIcon = false
      let icon = '👤'
      let title = 'User message'

      // Check if this is the first node of a subtask or compact branch (message_count === 1)
      if (
        node.branchId &&
        node.messageCount === 1 &&
        (node.branchId.startsWith('subtask_') || node.branchId.startsWith('compact_'))
      ) {
        showIcon = true
        if (node.branchId.startsWith('subtask_')) {
          icon = '💻'
          title = 'Subtask branch'
        } else if (node.branchId.startsWith('compact_')) {
          icon = '📦'
          title = 'Compact branch'
        }
      } else if (node.hasUserMessage) {
        showIcon = true
      }

      if (showIcon) {
        svg += `    <text x="${x + 32}" y="${y + node.height / 2 + 3}" text-anchor="middle" class="graph-node-label" style="font-size: 12px;" title="${title}">${icon}</text>\n`
      }

      // Add display name (subagent type) or request ID (first 8 chars) shifted more to the left
      const rawDisplayText = node.displayName || node.id.substring(0, 8)
      // Truncate if too long and escape HTML for security
      const displayText =
        rawDisplayText.length > 20
          ? escapeHtml(rawDisplayText.substring(0, 17) + '...')
          : escapeHtml(rawDisplayText)
      const fullText = escapeHtml(rawDisplayText) // Full text for tooltip

      svg += `    <text x="${x + 42}" y="${y + node.height / 2 + 3}" text-anchor="start" class="graph-node-label" style="font-weight: 500; font-size: 11px;" title="${fullText}">${displayText}</text>\n`

      // Add timestamp aligned more to the right
      const time = node.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      svg += `    <text x="${x + node.width - 22}" y="${y + node.height / 2 + 3}" text-anchor="end" class="graph-node-label" style="font-size: 10px; fill: #6b7280;">${time}</text>\n`

      // Add battery icon for context size
      if (node.contextTokens !== undefined && node.contextTokens > 0) {
        const { limit: maxTokens, isEstimate } = getModelContextLimit(node.model)
        const percentage = node.contextTokens / maxTokens
        const batteryColor = getBatteryColor(percentage)
        const isOverflow = percentage > 1

        const batteryX = x + node.width - 16
        const batteryY = y + 8
        const batteryWidth = 11
        const batteryHeight = 18

        // Battery group with hover area
        svg += `    <g class="battery-group">\n`

        // Battery nub (positive terminal)
        svg += `      <rect x="${batteryX + 2.5}" y="${batteryY - 2}" width="4" height="2" rx="1" ry="0" style="fill: #888;" />\n`

        // Battery casing
        svg += `      <rect x="${batteryX}" y="${batteryY}" width="${batteryWidth}" height="${batteryHeight}" rx="2" ry="2" style="fill: #f0f0f0; stroke: #888; stroke-width: 1;" />\n`

        // Battery level fill (from bottom to top)
        const fillHeight = (batteryHeight - 2) * Math.min(percentage, 1)
        const fillY = batteryY + 1 + (batteryHeight - 2) - fillHeight
        svg += `      <rect x="${batteryX + 1}" y="${fillY}" width="${batteryWidth - 2}" height="${fillHeight}" rx="1" ry="1" style="fill: ${batteryColor};" />\n`

        // Add overflow exclamation mark if needed
        if (isOverflow) {
          svg += `      <text x="${batteryX + batteryWidth / 2}" y="${batteryY + batteryHeight / 2 + 3}" text-anchor="middle" style="font-size: 9px; font-weight: bold; fill: white;">!</text>\n`
        }

        // Enhanced tooltip
        const percentageText = (percentage * 100).toFixed(1)
        const tooltipText = isEstimate
          ? `${node.contextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (estimated)`
          : `${node.contextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentageText}%)`

        svg += `      <title>${tooltipText}</title>\n`
        svg += `    </g>\n`
      }

      // Add sub-task indicators (removed as they would overlap with the new layout)

      // Add anchor points if this node needs them
      const anchors = nodeAnchors.get(node.id)
      if (anchors) {
        const anchorRadius = 4

        if (anchors.left) {
          // Determine if this is a source or target anchor based on edges
          const isSource = layout.edges.some(
            e =>
              e.source === node.id &&
              layout.nodes.find(n => n.id === e.target)?.branchId !== node.branchId
          )
          const anchorY = isSource ? y + node.height / 3 : y + (node.height * 2) / 3
          svg += `    <circle cx="${x}" cy="${anchorY}" r="${anchorRadius}" style="fill: ${color}; stroke: white; stroke-width: 2;" />\n`
        }

        if (anchors.right) {
          // Determine if this is a source or target anchor based on edges
          const isSource = layout.edges.some(
            e =>
              e.source === node.id &&
              layout.nodes.find(n => n.id === e.target)?.branchId !== node.branchId
          )
          const anchorY = isSource ? y + node.height / 3 : y + (node.height * 2) / 3
          svg += `    <circle cx="${x + node.width}" cy="${anchorY}" r="${anchorRadius}" style="fill: ${color}; stroke: white; stroke-width: 2;" />\n`
        }
      }

      // Add connection point at the bottom
      // Skip for first messages in compact/subtask branches, but keep for normal branches
      const isFirstInSpecialBranch =
        node.messageCount === 1 &&
        (node.branchId.startsWith('compact_') || node.branchId.startsWith('subtask_'))
      if (!isFirstInSpecialBranch) {
        svg += `    <circle cx="${x + node.width / 2}" cy="${y + node.height}" r="${nodeRadius - 2}" class="${nodeClass}" style="${node.branchId !== 'main' && !node.hasError ? `fill: ${color};` : ''} stroke: white; stroke-width: 2;" />\n`
      }

      if (interactive) {
        svg += `  </a>\n`
      }
    }
  }
  svg += '</g>\n'

  // Render tooltips last so they appear on top
  if (tooltips) {
    svg += '<g class="graph-tooltips">\n'
    svg += tooltips
    svg += '</g>\n'
  }

  svg += '</svg>'

  return svg
}
