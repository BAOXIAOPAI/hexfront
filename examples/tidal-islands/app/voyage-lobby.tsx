'use client';

import { useState, type FormEvent } from 'react';
import { Anchor, ArrowRight, BookOpen, Copy, DoorOpen, KeyRound, Settings2, Users, Waves } from 'lucide-react';
import { RULE_OPTIONS } from '../lib/rule-options';
import type { RoomOptions, RoomPlayer } from '../lib/room-service';
import './voyage-lobby.css';

type LobbyRoom = { code: string; hostId: string; players: RoomPlayer[]; options: RoomOptions };
type RoomAction = 'create' | 'join' | 'start' | 'updateOptions';
type LobbyMode = 'create' | 'join';

type RuleFieldsProps = {
  size: number;
  setSize: (size: number) => void;
  rule: string;
  setRule: (rule: string) => void;
  flags: Record<string, boolean>;
  setFlags: (flags: Record<string, boolean>) => void;
};

type LobbyProps = RuleFieldsProps & {
  room: LobbyRoom | null;
  playerId: string;
  restoring: boolean;
  connected: boolean;
  busy: boolean;
  mode: LobbyMode;
  setMode: (mode: LobbyMode) => void;
  name: string;
  setName: (name: string) => void;
  code: string;
  setCode: (code: string) => void;
  onRoomAction: (action: RoomAction) => Promise<boolean>;
  onEditRules: () => void;
  onCopyInvite: (code: string) => void;
  onPractice: () => void;
  hasPractice: boolean;
  onRules: () => void;
  onCancelRecovery: () => void;
};

function RuleFields({ size, setSize, rule, setRule, flags, setFlags, occupied = 0 }: RuleFieldsProps & { occupied?: number }) {
  const selected = RULE_OPTIONS.filter(option => flags[option.id]).length;
  return <>
    <fieldset className="voyage-size">
      <legend>游戏人数</legend>
      <div className="choice-row">
        {[3, 4, 5, 6].map(count => <button type="button" key={count} disabled={count < occupied}
          aria-pressed={size === count} className={size === count ? 'selected' : ''} onClick={() => setSize(count)}>
          {count} 人
        </button>)}
      </div>
    </fieldset>
    {size > 4 && <label className="voyage-field">扩展回合规则
      <select value={rule} onChange={event => setRule(event.target.value)}>
        <option value="paired">配对玩家回合 · 官方现行版</option>
        <option value="special">特殊建造阶段 · 官方历史版</option>
      </select>
    </label>}
    <details className="voyage-rules">
      <summary>可选规则 <span>已启用 {selected} 项</span></summary>
      <div className="rule-options">
        {RULE_OPTIONS.map(option => <label key={option.id} className="rule-option">
          <input type="checkbox" checked={!!flags[option.id]}
            onChange={event => setFlags({ ...flags, [option.id]: event.target.checked })}/>
          <span>{option.label}<small>{option.description}</small></span>
        </label>)}
      </div>
    </details>
  </>;
}

function WaitingRoom({ room, playerId, busy, connected, onEditRules, onRoomAction, onCopyInvite, ...fields }:
  RuleFieldsProps & Pick<LobbyProps, 'playerId' | 'busy' | 'connected' | 'onEditRules' | 'onRoomAction' | 'onCopyInvite'> & { room: LobbyRoom }) {
  const [inviteVisible, setInviteVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const host = room.hostId === playerId;
  const capacity = room.options.maxPlayers;
  const full = room.players.length === capacity;
  const enabledRules = RULE_OPTIONS.filter(option => room.options[option.id]);

  async function saveRules(event: FormEvent) {
    event.preventDefault();
    if (await onRoomAction('updateOptions')) setEditing(false);
  }

  return <>
    <div className="voyage-room-title">
      <h2>联机大厅</h2>
      <span className="voyage-count" aria-live="polite"><Users size={15}/>{room.players.length} / {capacity} 人</span>
    </div>
    <ul className="voyage-seats" aria-label="房间座位">
      {Array.from({ length: capacity }, (_, index) => {
        const player = room.players[index];
        return <li key={player?.id ?? index} className={!player ? 'empty-seat' : ''}>
          <i style={{ background: player?.color }}/>
          <span>{player?.name ?? '等待加入'}</span>
          {player?.id === room.hostId && <small>房主</small>}
          {player?.id === playerId && <small>你</small>}
        </li>;
      })}
    </ul>
    {host && <>
      <button type="button" className="voyage-secondary" aria-expanded={inviteVisible} aria-controls="voyage-invite"
        onClick={() => setInviteVisible(!inviteVisible)}><KeyRound size={16}/>{inviteVisible ? '隐藏邀请码' : '查看邀请码'}</button>
      <div className="voyage-invite" id="voyage-invite" hidden={!inviteVisible}>
        {inviteVisible && <>
          <div><small>房间邀请码</small><strong>{room.code}</strong></div>
          <button type="button" className="voyage-secondary" onClick={() => onCopyInvite(room.code)}><Copy size={15}/>复制邀请链接</button>
        </>}
      </div>
    </>}
    <section className="voyage-room-rules" aria-label="本局规则">
      <div className="voyage-room-title">
        <h3>本局规则</h3>
        {host && !editing && <button type="button" className="voyage-text" onClick={() => { onEditRules(); setEditing(true); }}>
          <Settings2 size={15}/>调整规则
        </button>}
      </div>
      {editing ? <form onSubmit={saveRules}>
        <RuleFields {...fields} occupied={room.players.length}/>
        <div className="voyage-edit-actions">
          <button type="button" className="voyage-secondary" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          <button className="gold-button" disabled={busy || !connected || fields.size < room.players.length}>保存规则</button>
        </div>
      </form> : <>
        <p>{room.options.expanded ? (room.options.extensionRule === 'paired' ? '扩展局 · 配对玩家回合' : '扩展局 · 特殊建造阶段') : '经典基础规则'}</p>
        {!!enabledRules.length && <ul className="voyage-rule-tags">{enabledRules.map(option => <li key={option.id}>{option.label}</li>)}</ul>}
      </>}
    </section>
    <div className="voyage-room-footer">
      {host && <button type="button" className="gold-button" disabled={!full || busy || editing || !connected} onClick={() => onRoomAction('start')}>
        开始游戏<ArrowRight size={17}/>
      </button>}
      <p role="status">{!connected ? '连接中断，正在重连…' : !full ? `还差 ${capacity - room.players.length} 位玩家` : host ? '玩家已到齐' : '玩家已到齐，等待房主开始游戏'}</p>
    </div>
  </>;
}

export function VoyageLobby(props: LobbyProps) {
  const { room, restoring, connected, busy, mode, setMode, name, setName, code, setCode,
    onRoomAction, onPractice, hasPractice, onRules, onCancelRecovery } = props;
  const canSubmit = name.trim().length > 0 && (mode === 'create' || /^[A-Z0-9]{6}$/.test(code));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && canSubmit) void onRoomAction(mode);
  }

  return <main className="voyage">
    <div className="voyage-shell">
      <div className="voyage-cover">
        <div className="voyage-cover-title">
          <Anchor size={25} strokeWidth={1.4} aria-hidden="true"/>
          <h1><span>CATAN</span>潮汐群岛</h1>
        </div>
      </div>
      <section className="voyage-panel" aria-label="游戏启动页">
        <button type="button" className="voyage-text voyage-handbook" onClick={onRules}><BookOpen size={16}/>规则手册</button>
        {restoring ? <div className="voyage-recovery">
          <h2>{connected ? '正在恢复房间…' : '正在重新连接房间…'}</h2>
          {!connected && <button type="button" className="voyage-secondary" onClick={onCancelRecovery}>返回启动页</button>}
        </div> : room ? <WaitingRoom {...props} key={room.code} room={room}/> : <>
          <h2>开启航程</h2>
          <div className="voyage-modes" role="group" aria-label="联机方式">
            <button type="button" aria-pressed={mode === 'create'} onClick={() => setMode('create')}><Anchor size={17}/>创建房间</button>
            <button type="button" aria-pressed={mode === 'join'} onClick={() => setMode('join')}><DoorOpen size={17}/>加入房间</button>
          </div>
          <form className="voyage-form" onSubmit={submit}>
            <label className="voyage-field">玩家昵称
              <input value={name} maxLength={20} onChange={event => setName(event.target.value)} placeholder="岛屿旅人" required/>
            </label>
            {mode === 'join' ? <label className="voyage-field">6 位邀请码
              <input className="code-input" value={code} maxLength={6} autoCapitalize="characters" autoComplete="off"
                onChange={event => setCode(event.target.value.toUpperCase())} placeholder="例如 ABCD23" required/>
            </label> : <RuleFields {...props}/>}
            <button className="gold-button" disabled={busy || !canSubmit}>
              {busy ? '准备中…' : mode === 'create' ? '创建房间' : '加入房间'}<ArrowRight size={17}/>
            </button>
          </form>
          <button type="button" className="voyage-secondary voyage-practice" disabled={busy} onClick={onPractice}>
            <Waves size={16}/>{hasPractice ? '继续本机练习' : '本机练习'}
          </button>
        </>}
      </section>
    </div>
  </main>;
}
