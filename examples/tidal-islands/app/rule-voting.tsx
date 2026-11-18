'use client';

import { useState, type FormEvent } from 'react';
import { Check, RotateCcw, Vote, X } from 'lucide-react';
import { RULE_OPTIONS, type RuleChanges, type RuleFlagOptions, type RuleProposal, type RuleVoteAction } from '../lib/rule-options';
import type { RoomPlayer } from '../lib/room-service';
import './rule-voting.css';

type Props = {
  flags: Partial<RuleFlagOptions>;
  proposal?: RuleProposal;
  players: RoomPlayer[];
  playerId: string;
  practice: boolean;
  disabled: boolean;
  finished: boolean;
  onAction: (action: RuleVoteAction, voterId: string) => Promise<boolean>;
};

function RuleDraft({ flags, disabled, onPropose }: {
  flags: Props['flags'];
  disabled: boolean;
  onPropose: (changes: RuleChanges) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<RuleChanges>({});
  const changes = Object.fromEntries(RULE_OPTIONS.filter(rule => draft[rule.id] !== undefined &&
    draft[rule.id] !== (flags[rule.id] ?? rule.defaultValue)).map(rule => [rule.id, draft[rule.id]]));
  const hasChanges = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges && !disabled && await onPropose(changes)) setDraft({});
  }

  return <form onSubmit={submit}>
    <p className="rule-voting-note">勾选要提议的设置，再发起表决。</p>
    <div className="rule-options">
      {RULE_OPTIONS.map(rule => {
        const enabled = flags[rule.id] ?? rule.defaultValue;
        return <label className="rule-option" key={rule.id}>
          <input type="checkbox" disabled={disabled} checked={draft[rule.id] ?? enabled}
            onChange={event => setDraft({ ...draft, [rule.id]: event.target.checked })}/>
          <span>{rule.label}<em>当前{enabled ? '开启' : '关闭'}</em><small>{rule.description}</small></span>
        </label>;
      })}
    </div>
    <button className="gold-button" disabled={disabled || !hasChanges}><Vote size={16}/>发起规则提案</button>
  </form>;
}

const results = {
  approved: '全票通过，规则已生效。',
  rejected: '有玩家反对，提案未通过。',
  withdrawn: '本次表决已结束。',
};

export function RuleVoting({ flags, proposal, players, playerId, practice, disabled, finished, onAction }: Props) {
  const [practiceSeat, setPracticeSeat] = useState<string | null>(null);
  const voterId = practice && practiceSeat ? practiceSeat : playerId;
  const pending = proposal?.status === 'pending';
  const voted = proposal && Object.hasOwn(proposal.votes, voterId);
  const yesCount = players.filter(player => proposal?.votes[player.id] === true).length;
  const proposer = players.find(player => player.id === proposal?.proposerId);
  const activeFlags = RULE_OPTIONS.filter(rule => flags[rule.id] ?? rule.defaultValue);

  return <section className="rule-voting" aria-labelledby="rule-voting-title">
    <h3 id="rule-voting-title"><Vote size={17}/>本局规则投票</h3>
    <p className="rule-voting-note">所有玩家（含发起人）都同意后，规则才生效。</p>
    <div className="rule-voting-current"><b>当前启用</b>{activeFlags.length ? activeFlags.map(rule => rule.label).join('、') : '经典基础规则'}</div>
    {practice && !finished && <label className="rule-voting-seat">本机练习席位
      <select value={voterId} onChange={event => setPracticeSeat(event.target.value)}>
        {players.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}
      </select>
      <small>切换席位可逐个投票，不会切换游戏回合。</small>
    </label>}
    {pending ? <div className="rule-voting-ballot">
      <div className="rule-voting-heading">
        <b>{proposer?.name ?? '玩家'}的提案</b>
        <span role="status">{yesCount} / {players.length} 票同意</span>
      </div>
      <ul className="rule-voting-changes" aria-label="提案改动">
        {RULE_OPTIONS.filter(rule => Object.hasOwn(proposal.changes, rule.id)).map(rule =>
          <li key={rule.id}><span>{rule.label}</span><b>{proposal.changes[rule.id] ? '关闭 → 开启' : '开启 → 关闭'}</b></li>)}
      </ul>
      <ul className="rule-voting-voters" aria-label="玩家投票状态">
        {players.map(player => <li key={player.id}><span>{player.name}{!practice && player.id === playerId ? '（你）' : ''}</span>
          <b>{proposal.votes[player.id] === true ? '同意' : proposal.votes[player.id] === false ? '反对' : '待投票'}</b></li>)}
      </ul>
      {!finished && <>
        {voted ? <p className="rule-voting-note">{practice ? '这个席位已投票' : '你已投票'}，等待其他玩家。</p> :
          <div className="rule-voting-actions">
            <button className="table-confirm" disabled={disabled} onClick={() => onAction({ type: 'voteRules', proposalId: proposal.id, approve: true }, voterId)}><Check size={15}/>同意</button>
            <button className="table-secondary" disabled={disabled} onClick={() => onAction({ type: 'voteRules', proposalId: proposal.id, approve: false }, voterId)}><X size={15}/>反对</button>
          </div>}
        {proposal.proposerId === voterId && <button className="rule-voting-withdraw" disabled={disabled}
          onClick={() => onAction({ type: 'withdrawRuleProposal', proposalId: proposal.id }, voterId)}><RotateCcw size={13}/>撤回提案</button>}
      </>}
    </div> : <>
      {proposal && proposal.status !== 'pending' && <p className={'rule-voting-result '+proposal.status} role="status">{results[proposal.status]}</p>}
      {!finished && <RuleDraft key={proposal?.id} flags={flags} disabled={disabled} onPropose={changes => onAction({ type: 'proposeRules', changes }, voterId)}/>}
    </>}
  </section>;
}
