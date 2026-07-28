import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type FirewallRule } from '../api';
import { FirewallGraphEditor } from '../components/FirewallGraphEditor';

const PROTOCOLS = ['any', 'tcp', 'udp'] as const;

function emptyRule(): FirewallRule {
  return { id: crypto.randomUUID(), action: 'allow', protocol: 'any', cidr: '' };
}

export function FirewallProfileEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [defaultAction, setDefaultAction] = useState<'allow' | 'deny'>('deny');
  const [rules, setRules] = useState<FirewallRule[]>([]);
  const [nodeLayout, setNodeLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew || !id) return;
    api
      .getFirewallProfile(id)
      .then((p) => {
        setName(p.name);
        setDefaultAction(p.defaultAction);
        setRules(p.rules);
        setNodeLayout(p.nodeLayout);
        setLoaded(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load profile'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const selectedRule = rules.find((r) => r.id === selectedRuleId) ?? null;

  function updateSelectedRule(patch: Partial<FirewallRule>) {
    setRules((rs) => rs.map((r) => (r.id === selectedRuleId ? { ...r, ...patch } : r)));
  }

  function addRule() {
    const rule = emptyRule();
    setRules((rs) => [...rs, rule]);
    setSelectedRuleId(rule.id);
  }

  function deleteSelectedRule() {
    if (!selectedRuleId) return;
    setRules((rs) => rs.filter((r) => r.id !== selectedRuleId));
    // Must drop the layout entry too — a stale key referencing a rule id
    // that no longer exists fails firewallProfileSchema's superRefine on
    // save ("nodeLayout references unknown rule id"), permanently blocking
    // Save with an opaque "invalid request" until the page is reloaded.
    setNodeLayout((nl) => {
      const { [selectedRuleId]: _removed, ...rest } = nl;
      return rest;
    });
    setSelectedRuleId(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const draft = { name: name.trim(), defaultAction, rules, nodeLayout };
      if (isNew) {
        const created = await api.createFirewallProfile(draft);
        navigate(`/firewall-profiles/${created.id}`, { replace: true });
      } else if (id) {
        await api.updateFirewallProfile(id, draft);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="vm-page">Loading…</div>;

  const canSave = name.trim().length > 0 && rules.every((r) => r.cidr.trim().length > 0);

  return (
    <div className="vm-page" style={{ maxWidth: 'none' }}>
      <button
        className="vm-btn vm-btn--ghost"
        style={{ padding: 0, marginBottom: 12, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
        onClick={() => navigate('/firewall-profiles')}
      >
        ← firewall profiles
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <input
          className="vm-input"
          style={{ width: 260, fontSize: 15, fontWeight: 600 }}
          placeholder="Profile name"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="vm-select"
          value={defaultAction}
          onChange={(e) => setDefaultAction(e.target.value as 'allow' | 'deny')}
          title="What happens to traffic matching none of the rules below"
        >
          <option value="deny">Default: block everything else</option>
          <option value="allow">Default: allow everything else</option>
        </select>
        {error && <span className="vm-error-text">{error}</span>}
        <div style={{ flex: 1 }} />
        <button className="vm-btn vm-btn--secondary" onClick={addRule}>
          + Add rule
        </button>
        <button className="vm-btn vm-btn--primary" disabled={busy || !canSave} onClick={save}>
          Save
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--fg2)', marginBottom: 10 }}>
        Drag a rule node up or down to change evaluation order — rules are checked top to bottom, first match wins. DNS is
        always allowed regardless of these rules. Lateral traffic to other private networks (LAN, other sandboxes) is
        always blocked, regardless of this profile.
      </div>

      <div className="vm-fw-editor-grid">
        {rules.length === 0 ? (
          <div className="vm-panel">
            <div className="vm-fw-empty">No rules yet — add one, or leave empty and rely on the default action above.</div>
          </div>
        ) : (
          <FirewallGraphEditor
            rules={rules}
            defaultAction={defaultAction}
            nodeLayout={nodeLayout}
            selectedRuleId={selectedRuleId}
            onSelectRule={setSelectedRuleId}
            onReorder={setRules}
            onLayoutChange={setNodeLayout}
          />
        )}

        <div className="vm-panel">
          <div className="vm-panel-head">{selectedRule ? 'Edit rule' : 'Rule'}</div>
          {!selectedRule ? (
            <div className="vm-fw-empty">Click a rule node to edit it.</div>
          ) : (
            <div className="vm-fw-rule-form">
              <div>
                <div style={{ fontSize: 11, color: 'var(--fg3)', marginBottom: 3 }}>Label (optional)</div>
                <input
                  className="vm-input"
                  value={selectedRule.label ?? ''}
                  maxLength={64}
                  placeholder="e.g. Windows Update"
                  onChange={(e) => updateSelectedRule({ label: e.target.value })}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--fg3)', marginBottom: 3 }}>Destination CIDR</div>
                <input
                  className="vm-input"
                  value={selectedRule.cidr}
                  placeholder="e.g. 93.184.216.0/24"
                  onChange={(e) => updateSelectedRule({ cidr: e.target.value.trim() })}
                />
              </div>
              <div className="vm-fw-rule-row">
                <div>
                  <div style={{ fontSize: 11, color: 'var(--fg3)', marginBottom: 3 }}>Action</div>
                  <select
                    className="vm-select"
                    value={selectedRule.action}
                    onChange={(e) => updateSelectedRule({ action: e.target.value as 'allow' | 'deny' })}
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Block</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--fg3)', marginBottom: 3 }}>Protocol</div>
                  <select
                    className="vm-select"
                    value={selectedRule.protocol}
                    onChange={(e) => {
                      const protocol = e.target.value as (typeof PROTOCOLS)[number];
                      updateSelectedRule(
                        protocol === 'any' ? { protocol, portFrom: undefined, portTo: undefined } : { protocol },
                      );
                    }}
                  >
                    {PROTOCOLS.map((p) => (
                      <option key={p} value={p}>
                        {p === 'any' ? 'Any' : p.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {selectedRule.protocol !== 'any' && (
                <div className="vm-fw-rule-row">
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--fg3)', marginBottom: 3 }}>Port from</div>
                    <input
                      className="vm-input"
                      type="number"
                      min={1}
                      max={65535}
                      value={selectedRule.portFrom ?? ''}
                      onChange={(e) => updateSelectedRule({ portFrom: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--fg3)', marginBottom: 3 }}>Port to (optional)</div>
                    <input
                      className="vm-input"
                      type="number"
                      min={1}
                      max={65535}
                      value={selectedRule.portTo ?? ''}
                      onChange={(e) => updateSelectedRule({ portTo: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </div>
                </div>
              )}
              <button className="vm-btn vm-btn--danger vm-btn--sm" style={{ justifySelf: 'start' }} onClick={deleteSelectedRule}>
                Delete rule
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
