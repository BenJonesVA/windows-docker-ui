import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { FirewallRule } from '../api';

const ROW_HEIGHT = 88;
const RULE_X = 380;
const SOURCE_X = 40;
const DEFAULT_GAP = 70;

const ALLOW_COLOR = 'var(--ok)';
const DENY_COLOR = 'var(--danger)';

function ruleLabel(rule: FirewallRule): string {
  const proto = rule.protocol === 'any' ? '' : ` ${rule.protocol}`;
  const port =
    rule.portFrom !== undefined
      ? `:${rule.portFrom}${rule.portTo !== undefined && rule.portTo !== rule.portFrom ? `-${rule.portTo}` : ''}`
      : '';
  return `${rule.label ? `${rule.label} — ` : ''}${rule.cidr}${proto}${port}`;
}

const baseNodeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  padding: '8px 12px',
  borderRadius: 7,
  color: 'var(--fg)',
  background: 'var(--panel)',
  width: 220,
};

function ruleNodeStyle(action: 'allow' | 'deny', selected: boolean): React.CSSProperties {
  const color = action === 'allow' ? ALLOW_COLOR : DENY_COLOR;
  return {
    ...baseNodeStyle,
    border: `1.5px solid ${color}`,
    boxShadow: selected ? `0 0 0 3px var(--accent-soft)` : undefined,
  };
}

function endpointNodeStyle(): React.CSSProperties {
  return {
    ...baseNodeStyle,
    width: 150,
    fontWeight: 600,
    border: '1px solid var(--line2)',
    background: 'var(--bg2)',
    textAlign: 'center',
  };
}

// Builds a star topology only: "This Sandbox" (fixed source) fans out to
// each rule (ordered top-to-bottom = iptables evaluation order) plus a
// fixed "everything else" default endpoint, always last. Deliberately no
// destination-to-destination or instance-to-instance edges — the guest has
// no L2 presence on its bridge (NETWORK=user/passt), so anything richer than
// a star can't actually be enforced by docker/firewall.ts.
function buildGraph(
  rules: FirewallRule[],
  defaultAction: 'allow' | 'deny',
  nodeLayout: Record<string, { x: number; y: number }>,
  selectedRuleId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const totalHeight = Math.max(rules.length, 1) * ROW_HEIGHT;

  nodes.push({
    id: 'source',
    data: { label: 'This Sandbox' },
    position: nodeLayout.source ?? { x: SOURCE_X, y: totalHeight / 2 - 20 },
    draggable: false,
    selectable: false,
    style: endpointNodeStyle(),
  });

  rules.forEach((rule, i) => {
    const position = nodeLayout[rule.id] ?? { x: RULE_X, y: i * ROW_HEIGHT };
    nodes.push({
      id: rule.id,
      data: { label: ruleLabel(rule) },
      position,
      style: ruleNodeStyle(rule.action, rule.id === selectedRuleId),
    });
    edges.push({
      id: `e-${rule.id}`,
      source: 'source',
      target: rule.id,
      style: { stroke: rule.action === 'allow' ? ALLOW_COLOR : DENY_COLOR },
      markerEnd: { type: MarkerType.ArrowClosed, color: rule.action === 'allow' ? ALLOW_COLOR : DENY_COLOR },
    });
  });

  const defaultPosition = nodeLayout.__default__ ?? { x: RULE_X, y: rules.length * ROW_HEIGHT + DEFAULT_GAP };
  nodes.push({
    id: '__default__',
    data: { label: `Everything else — ${defaultAction === 'allow' ? 'Allow' : 'Block'}` },
    position: defaultPosition,
    draggable: false,
    selectable: false,
    style: endpointNodeStyle(),
  });
  edges.push({
    id: 'e-default',
    source: 'source',
    target: '__default__',
    style: {
      stroke: defaultAction === 'allow' ? ALLOW_COLOR : DENY_COLOR,
      strokeDasharray: '4 3',
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: defaultAction === 'allow' ? ALLOW_COLOR : DENY_COLOR,
    },
  });

  return { nodes, edges };
}

export function FirewallGraphEditor({
  rules,
  defaultAction,
  nodeLayout,
  selectedRuleId,
  onSelectRule,
  onReorder,
  onLayoutChange,
}: {
  rules: FirewallRule[];
  defaultAction: 'allow' | 'deny';
  nodeLayout: Record<string, { x: number; y: number }>;
  selectedRuleId: string | null;
  onSelectRule: (id: string | null) => void;
  onReorder: (rules: FirewallRule[]) => void;
  onLayoutChange: (nodeLayout: Record<string, { x: number; y: number }>) => void;
}) {
  const graph = useMemo(
    () => buildGraph(rules, defaultAction, nodeLayout, selectedRuleId),
    // nodeLayout deliberately excluded — it's only the *initial* position
    // source; once mounted, drag state below is the source of truth so a
    // parent re-render from onLayoutChange doesn't snap a node giving smooth
    // dragging. Re-included whenever rules/defaultAction/selection change,
    // since those can add/remove/restyle nodes outside of dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rules, defaultAction, selectedRuleId],
  );
  const [nodes, setNodes] = useState<Node[]>(graph.nodes);

  useEffect(() => {
    setNodes(graph.nodes);
  }, [graph]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  function handleNodeDragStop(_event: unknown, dragged: Node) {
    if (dragged.id === 'source' || dragged.id === '__default__') return;
    const ruleNodes = nodes
      .filter((n) => n.id !== 'source' && n.id !== '__default__')
      .map((n) => (n.id === dragged.id ? dragged : n));

    // Persist EVERY rule node's position, not just the dragged one — an
    // untouched node otherwise has no nodeLayout entry, so buildGraph falls
    // back to an index-derived y next render. Mixing an absolute (dragged)
    // position with index-derived ones lets rendered order silently drift
    // from array order, and the next drag would re-sort by that drifted
    // render order — reordering rules the user never touched.
    const layout = { ...nodeLayout };
    for (const n of ruleNodes) layout[n.id] = n.position;
    onLayoutChange(layout);

    // Re-derive rule order from vertical position — dragging a node in the
    // graph is what lets the user control iptables evaluation order
    // (docker/firewall.ts populateChain appends rules in array order).
    const ordered = ruleNodes
      .sort((a, b) => a.position.y - b.position.y)
      .map((n) => rules.find((r) => r.id === n.id))
      .filter((r): r is FirewallRule => Boolean(r));
    if (ordered.length === rules.length) onReorder(ordered);
  }

  return (
    <div className="vm-fw-canvas">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={(_, node) => {
          if (node.id !== 'source' && node.id !== '__default__') onSelectRule(node.id);
        }}
        onPaneClick={() => onSelectRule(null)}
        nodesConnectable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="var(--line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
