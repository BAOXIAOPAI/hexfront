'use client';
import React,{useState,useEffect,useRef,useCallback} from 'react';
import {Anchor,ArrowLeft,ArrowRight,BookOpen,Check,ChevronDown,ChevronLeft,ChevronRight,Copy,Crown,Dices,Flag,Globe2,Hammer,House,Layers,Maximize2,Plus,RotateCcw,Route,ScrollText,Settings2,Shield,Sparkles,Swords,ArrowLeftRight as Trade,Users,Volume2,VolumeX,Waves,X} from 'lucide-react';
import {newGame,applyAction,publicState} from '../lib/engine.js';
import {RULE_OPTIONS,type RuleProposal,type RuleVoteAction} from '../lib/rule-options';
import {availableHand,stagedBuildOptions,stagedBuildAffordability,spendStagedBuild,maritimeQuote,reconcileStaged,canDiscard} from '../lib/ui-staging';
import {TableCards,ScatteredCards,StagingSummary,RadialActions,ResourceOffer,ResourcePicker} from './table-controls';
import './table-controls.css';
import './action-fan.css';
import './player-army.css';
import {FloatingActions} from './floating-actions';
import {VoyageLobby} from './voyage-lobby';
import {RuleVoting} from './rule-voting';

const RES=['wood','brick','sheep','wheat','ore'];
const LABEL:Record<string,string>={wood:'木材',brick:'砖块',sheep:'羊毛',wheat:'麦子',ore:'矿石',desert:'荒漠',knight:'骑士',roadBuilding:'修路',yearOfPlenty:'丰收',monopoly:'垄断',victoryPoint:'胜利点',victory:'胜利点',road_building:'修路',year_of_plenty:'丰收'};
const COLORS:Record<string,string>={wood:'#437957',brick:'#ba7651',sheep:'#91ad68',wheat:'#d0b15d',ore:'#8b9b9f',desert:'#dbc99d'};
const PLAYERS=[{id:'p1',name:'潮汐船长',color:'#e7b85b'},{id:'p2',name:'林间旅人',color:'#70b8ae'},{id:'p3',name:'赤陶船长',color:'#d77a69'},{id:'p4',name:'夜航者',color:'#a197cd'}];
type RoomAction = 'create' | 'join' | 'start' | 'updateOptions';
type BuildKind = 'road' | 'settlement' | 'city' | 'development';
type BuildAction = {type: 'buildRoad' | 'buildSettlement' | 'buildCity' | 'buyDevelopment'; edgeId?: string; vertexId?: string};
type BuildDraft = {kind: BuildKind; action: BuildAction; setup?: {phase: string; step: number; playerId: string}};
const blank=()=>Object.fromEntries(RES.map(r=>[r,0]));
function Icon({name,size=26}:{name:string,size?:number}){return <img alt={LABEL[name]||name} draggable={false} src={`/assets/${name}.svg`} width={size} height={size}/>}
function Dice({n,rolling=false}:{n:number,rolling?:boolean}){return <div className={'dice '+(rolling?'rolling':'')}>{Array.from({length:9},(_,i)=><i key={i} className={([[],[4],[0,8],[0,4,8],[0,2,6,8],[0,2,4,6,8],[0,2,3,5,6,8]][n]||[]).includes(i)?'pip':''}/>)}</div>}
function total(r:any){return Object.values(r||{}).reduce((a:number,b:any)=>a+Number(b||0),0) as number}
function arr(v:any){return Array.isArray(v)?v:Object.values(v||{})}

export default function Game(){
 const [practice,setPractice]=useState<any>(null),[room,setRoom]=useState<any>(null),[auth,setAuth]=useState<any>(null),[view,setView]=useState('overhead'),[angle,setAngle]=useState(0),[layoutMode,setLayoutMode]=useState<'dashboard'|'minimal'>('dashboard');
 const [showPractice,setShowPractice]=useState(false),[ready,setReady]=useState(false);
 const [modal,setModal]=useState<string|null>(null),[tab,setTab]=useState<'create'|'join'>('create'),[name,setName]=useState(''),[code,setCode]=useState(''),[size,setSize]=useState(4),[rule,setRule]=useState('paired');
 const [muted,setMuted]=useState(false),[busy,setBusy]=useState(false),[rolling,setRolling]=useState(false),[toast,setToast]=useState(''),[tool,setTool]=useState('');
 const [give,setGive]=useState('wood'),[devCard,setDevCard]=useState<any>(null),[secondResource,setSecondResource]=useState('wheat');
 const [drag,setDrag]=useState<any>(null),[hoverDrop,setHoverDrop]=useState(false),[rulesTab,setRulesTab]=useState('basics'),[connected,setConnected]=useState(true),[ruleFlags,setRuleFlags]=useState<Record<string,boolean>>(Object.fromEntries(RULE_OPTIONS.map(r=>[r.id,r.defaultValue]))),[portMixed,setPortMixed]=useState(false),[building,setBuilding]=useState(false),[returnView,setReturnView]=useState('overhead'),[tradeTarget,setTradeTarget]=useState(''),[selectedPort,setSelectedPort]=useState<any>(null);
 const [staged,setStaged]=useState<Record<string,number>>(blank()),[tableMode,setTableMode]=useState<string|null>(null),[receiveCards,setReceiveCards]=useState<Record<string,number>>(blank()),[buildDraft,setPendingBuild]=useState<BuildDraft|null>(null),[tableTradeId,setTableTradeId]=useState<string|null>(null),[burnCards,setBurnCards]=useState<Record<string,number>|null>(null),[practiceViewer,setPracticeViewer]=useState<string|null>(null),[pendingRobber,setPendingRobber]=useState<{tileId:any,targetId:string|null}|null>(null);
 const lastTableReset=useRef<any>(null),lastViewer=useRef<string|null>(null);
 const toastTimer=useRef<any>(null),pollRef=useRef<any>(null),lastDice=useRef(''),dragMoved=useRef(false);
 const say=useCallback((s:string)=>{setToast(s);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),4500)},[]);
 const sound=useCallback((kind='card1')=>{if(muted)return;const a=new Audio(`/assets/${kind}.wav`);a.volume=kind.startsWith('dice')?.45:.28;a.play().catch(()=>{});},[muted]);
 useEffect(()=>{
  const savedLayout=localStorage.getItem('tidal-layout-mode');
  if(savedLayout==='minimal'||savedLayout==='dashboard')setLayoutMode(savedLayout);
  try{
   const saved=JSON.parse(sessionStorage.getItem('tidal-practice-v1')||'null');
   if(saved?.board?.tiles&&saved?.players?.length)setPractice(saved);
  }catch{}
  const invite=new URLSearchParams(location.search).get('room')?.toUpperCase();
  if(invite){setCode(invite.slice(0,6));setTab('join')}
  try{
   const saved=JSON.parse(localStorage.getItem('tidal-room')||'null');
   if(saved?.code&&saved?.token&&saved?.playerId&&(!invite||saved.code===invite))setAuth(saved);
  }catch{}
  setReady(true);
 },[]);
 useEffect(()=>{if(practice)sessionStorage.setItem('tidal-practice-v1',JSON.stringify(practice))},[practice]);
 const playerId=auth?.playerId||practiceViewer||(practice?.phase==='discard'?Object.keys(practice.discardRequired||{})[0]:null)||practice?.activePlayerId||'p1';
 const game:any=room?room.game:(practice?publicState(practice,playerId):null);
 const legal:any=game?.legal||room?.legalActions||{};
 const players:any[]=game?.players||room?.players||PLAYERS;
 const me=players.find(p=>p.id===playerId)||players[0];
 const active=players.find(p=>p.id===game?.activePlayerId);
 const mine=game?.activePlayerId===playerId;
 const hand=me?.resources||game?.hand?.resources||game?.resources||{};
 const usableHand:Record<string,number>=availableHand(hand,staged);
 const buildOptions=stagedBuildOptions(staged,legal);
 const affordableBuild=stagedBuildAffordability(staged);
 const bankQuote=maritimeQuote(staged,'bank',legal.bankRatios||{},!!legal.hasGenericPort,!!game?.options?.mixedPortTrade,false);
 const portQuote=maritimeQuote(staged,'port',legal.bankRatios||{},!!legal.hasGenericPort,!!game?.options?.mixedPortTrade,portMixed);
 const mixedQuote=maritimeQuote(staged,'port',legal.bankRatios||{},!!legal.hasGenericPort,!!game?.options?.mixedPortTrade,true);
 const tableTrades:any[]=game?.tableTrades||[];
 const activeTable=tableTrades.find(t=>t.id===tableTradeId);
 const myOffer=activeTable?(activeTable.from===playerId?activeTable.give:activeTable.response):null;
 const otherOffer=activeTable?(activeTable.from===playerId?activeTable.response:activeTable.give):null;
 const otherTrader=activeTable?players.find(p=>p.id===(activeTable.from===playerId?activeTable.to:activeTable.from)):players.find(p=>p.id===tradeTarget);
 const offerMatches=!!myOffer&&RES.every(r=>(myOffer[r]||0)===(staged[r]||0));
 const developments=me?.developmentCards||me?.development||game?.developmentCards||[];
 const isPractice=!room;
 const phase=game?.phase;
 const setupPlacement=phase==='setup_settlement'||phase==='setup_road';
 const specialPlacement=setupPlacement||phase==='road_building';
 const draftSetup=buildDraft?.setup;
 const staleSetup=!!draftSetup&&(draftSetup.phase!==phase||draftSetup.step!==game?.setupStep||draftSetup.playerId!==playerId);
 const pendingBuild=staleSetup?null:buildDraft;
 const showLobby=room?room.status==='lobby':!showPractice||!practice;
 const roomFinished=room?.status==='finished';
 const showingResults=!showLobby&&phase==='finished';
 const ruleProposal:RuleProposal|undefined=game?.ruleProposal;
 const ruleVotePending=ruleProposal?.status==='pending';
 const pLabel:Record<string,string>={setup_settlement:'放置起始村庄',setup_road:'连接起始道路',roll:'掷骰 · 开始回合',actions:'交易与建造',discard:'弃置一半资源',robber:'移动强盗',steal:'选择偷取对象',road_building:'建造免费道路',finished:'航程结束'};
 const phaseNotice=phase==='roll'?'请先掷骰，再进行建造和交易':phase==='robber'?'请先确认强盗位置':phase==='steal'?'请先选择强盗偷取对象':phase==='discard'?'请先完成弃牌':String(phase).startsWith('setup')?'请先完成起始村庄和道路放置':phase==='finished'?'本局已结束':'';
 const dice=game?.dice||game?.lastDice||[3,4];
 const effectiveTool=phase==='setup_settlement'?'settlement':phase==='setup_road'||phase==='road_building'?'road':tool;
 const handleResponse=(data:any)=>{if(data.error)throw new Error(data.error);setRoom((prev:any)=>prev?.code===data.room.code&&prev.version>data.room.version?prev:data.room);if(data.token){const a={code:data.room.code,token:data.token,playerId:data.playerId};setAuth(a);localStorage.setItem('tidal-room',JSON.stringify(a))}setConnected(true);return data};
 const request=async(body:any)=>{const res=await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json',...(body.token?{Authorization:`Bearer ${body.token}`}:{})},body:JSON.stringify({...body,token:undefined})});return handleResponse(await res.json());};
 useEffect(()=>{
  if(!auth||roomFinished)return;
  let cancelled=false;
  const poll=async()=>{
   try{
    const response=await fetch('/api/room?code='+auth.code,{headers:{Authorization:'Bearer '+auth.token}});
    if(cancelled)return;
    if(response.status===401||response.status===404){
     setAuth(null);setRoom(null);localStorage.removeItem('tidal-room');setConnected(true);
     say('之前的房间已失效，请创建或加入房间。');return;
    }
    const data=await response.json() as {room:{code:string;version:number};error?:string};
    if(cancelled)return;
    if(data.error)throw Error(data.error);
    setRoom((prev:any)=>prev?.code===data.room.code&&prev.version>data.room.version?prev:data.room);
    setConnected(true);
   }catch{if(!cancelled)setConnected(false)}
  };
  poll();pollRef.current=setInterval(poll,1700);
  return()=>{cancelled=true;clearInterval(pollRef.current)};
 },[auth,roomFinished,say]);
 useEffect(()=>{if(staleSetup)setPendingBuild(null)},[staleSetup]);
 useEffect(()=>{
  if(showLobby||!ruleProposal)return;
  if(ruleProposal.status==='pending'){
   if(isPractice||ruleProposal.proposerId!==playerId)say('有新的规则提案，请在右上角游戏设置中投票。');
  }else if(ruleProposal.status==='approved')say('规则提案全票通过，已在本局生效。');
  else if(ruleProposal.status==='rejected')say('有玩家反对，规则提案未通过。');
  else if(phase!=='finished')say('规则提案已撤回。');
 },[showLobby,room?.code,ruleProposal?.id,ruleProposal?.status,say]);
 useEffect(()=>{if(!game)return;const stamp=JSON.stringify([game.dice,game.turn,game.turnNumber]);if(lastDice.current&&lastDice.current!==stamp&&game.dice){setRolling(true);sound('dice1');setTimeout(()=>setRolling(false),1200)}lastDice.current=stamp},[game?.dice,game?.turn,game?.turnNumber]);
 useEffect(()=>{if(lastViewer.current!==playerId){setStaged(blank());setPendingBuild(null);lastViewer.current=playerId}setStaged(v=>reconcileStaged(hand,v))},[playerId,JSON.stringify(hand)]);
 useEffect(()=>{const reset=game?.tableResetId??0;if(lastTableReset.current!==null&&lastTableReset.current!==reset){setStaged(blank());setPendingBuild(null);setTableMode(null);setTableTradeId(null);setReceiveCards(blank());setPracticeViewer(null);setBuilding(false);setView(returnView);say('掷出 7：所有桌面牌已拿回手中，请按提示弃牌。')}lastTableReset.current=reset},[game?.tableResetId]);
 useEffect(()=>{setPracticeViewer(null);setPendingBuild(null);setStaged(blank());setTableMode(null);setTableTradeId(null)},[game?.activePlayerId]);
 useEffect(()=>{if(tableTradeId&&!tableTrades.some(t=>t.id===tableTradeId)){setTableTradeId(null);setStaged(blank());setTableMode(null)}},[JSON.stringify(tableTrades.map(t=>t.id))]);
 useEffect(()=>{const result=game?.tableTradeResult;if(result){say(result.status==='accepted'?'双方已确认，资源交换完成。':'这笔交易未达成。');if(isPractice){setPracticeViewer(null);setTradeTarget('')}}} ,[game?.tableTradeResult?.id]);
 useEffect(()=>{setPendingRobber(null)},[playerId,phase,game?.tableResetId,game?.options?.friendlyRobber]);
 async function act(action:any){if(busy)return null;setBusy(true);let next:any=null;try{
  if(action.type==='roll'){setRolling(true);sound('dice1')}if(isPractice){let a={...action};if(a.type==='roll'){const b=new Uint32Array(2);crypto.getRandomValues(b);for(let i=0;i<2;i++)while(b[i]>=4294967292)crypto.getRandomValues(b.subarray(i,i+1));a.dice=[1+b[0]%6,1+b[1]%6];await new Promise(r=>setTimeout(r,900));}const s=applyAction(practice,playerId,a);setPractice(s);next=publicState(s,playerId)}
  else {const data=await request({type:'action',code:auth.code,token:auth.token,version:room.version,action});next=data.room.game;}
  sound(action.type.startsWith('build')?'build1':'card2');if((action.type.startsWith('build')||action.type==='buyDevelopment')&&building){setBuilding(false);setView(returnView)}setTool('');if(!['buildRoad','buildSettlement','buildCity'].includes(action.type))setModal(null);return next;
 }catch(e:any){say(e.message);return null;}finally{setBusy(false);setRolling(false)}}
 async function submitRuleAction(action:RuleVoteAction,voterId:string){
  if(busy)return false;
  setBusy(true);
  try{
   if(isPractice)setPractice(applyAction(practice,voterId,action));
   else await request({type:'action',code:auth.code,token:auth.token,version:room.version,action});
   return true;
  }catch(e:any){say(e.message);return false}
  finally{setBusy(false)}
 }
 async function roomAction(type:RoomAction){
  if(busy)return false;
  setBusy(true);
  try{
   const options={expanded:size>4,extensionRule:rule,maxPlayers:size,...ruleFlags};
   await request(type==='create'?{type,name,options}:type==='join'?{type,code:code.trim().toUpperCase(),name}:{type,code:auth.code,token:auth.token,version:room.version,...(type==='updateOptions'?{options}:{})});
   setShowPractice(false);setPendingBuild(null);setModal(null);sound('card2');return true;
  }catch(e:any){say(e.message);return false}
  finally{setBusy(false)}
 }
 function editRoomRules(){setSize(room.options.maxPlayers);setRule(room.options.extensionRule);setRuleFlags(Object.fromEntries(RULE_OPTIONS.map(r=>[r.id,room.options[r.id]??r.defaultValue])))}
 function freshPractice(expanded=false){setStaged(blank());setTableMode(null);setTableTradeId(null);setPendingBuild(null);setPracticeViewer(null);setAuth(null);setRoom(null);localStorage.removeItem('tidal-room');setShowPractice(true);setPractice(newGame(expanded?[...PLAYERS,{id:'p5',name:'珊瑚探险家',color:'#d99bc3'}]:PLAYERS,{expanded,extensionRule:rule,...ruleFlags}));setModal(null);setBuilding(false);setTool('');say('本机轮流练习已开始。每位玩家依次放置两座村庄和道路。');}
 function chooseTool(t:string){setTool(t);sound('card1');if(!mine)say('等待当前玩家完成行动');}
 function closeBuilding(){setPendingBuild(null);setBuilding(false);setTool('');setView(returnView);sound('card1')}
 const list=(...keys:string[])=>{for(const k of keys){if(Array.isArray(legal[k]))return legal[k].map((v:any)=>v.id??v)}return []};
 const baseBoard=game?.board;
 const board=pendingBuild&&baseBoard?{...baseBoard,vertices:baseBoard.vertices.map((v:any)=>v.id===pendingBuild.action.vertexId?{...v,owner:playerId,level:pendingBuild.kind==='city'?2:1}:v),edges:baseBoard.edges.map((e:any)=>e.id===pendingBuild.action.edgeId?{...e,owner:playerId}:e)}:baseBoard;
 const vertices=arr(board?.vertices),edges=arr(board?.edges),tiles=arr(board?.tiles),ports=arr(board?.ports);
 const vertexMap=Object.fromEntries(vertices.map((v:any)=>[v.id,v]));
 const coords=vertices.flatMap((v:any)=>[Math.abs(v.x),Math.abs(v.y)]);
 const unit=(Math.max(...coords,1)>15)?1:70;
 const tilexy=(t:any)=>({x:Math.sqrt(3)*(t.q+t.r/2)*64,y:t.r*96});
 const minX=Math.min(...tiles.map((t:any)=>tilexy(t).x),-200)-135,maxX=Math.max(...tiles.map((t:any)=>tilexy(t).x),200)+135;
 const minY=Math.min(...tiles.map((t:any)=>tilexy(t).y),-150)-140,maxY=Math.max(...tiles.map((t:any)=>tilexy(t).y),150)+140;
 const point=(v:any)=>({x:v.x*unit,y:v.y*unit});
 const ownerColor=(id:string)=>players.find(p=>p.id===id)?.color||'#eee';
 const canVertices=list(effectiveTool==='city'?'cities':'settlements',effectiveTool==='city'?'buildCity':'buildSettlement','vertices');
 const canEdges=list('roads','buildRoad','edges');
 const robberId=pendingRobber?.tileId??game?.robberTile??game?.robberTileId??game?.robber??board?.robber;
 async function reviseStaged(next:Record<string,number>){if(busy)return false;if(pendingBuild&&!pendingBuild.setup)setPendingBuild(null);if(activeTable?.confirmed?.includes(playerId)){const result=await act({type:'unconfirmTableTrade',tradeId:activeTable.id});if(!result)return false;}setStaged(next);return true}
 function stageCard(r:string){if(busy||burnCards||(phase==='discard'&&!legal.discardCount))return;if((usableHand[r]||0)>0){reviseStaged({...staged,[r]:(staged[r]||0)+1});sound('card2')}}
 async function returnCard(r:string){if(busy||burnCards||!(staged[r]>0))return false;const returned=await reviseStaged({...staged,[r]:Math.max(0,(staged[r]||0)-1)});if(returned)sound('card1');return returned}
 function dragStart(e:React.PointerEvent,r:string,fromTable=false){if(e.button!==0||busy)return;dragMoved.current=false;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);setDrag({resource:r,fromTable,x:e.clientX,y:e.clientY,originX:e.clientX,originY:e.clientY});sound('card1')}
 function dragMove(e:React.PointerEvent){if(!drag)return;dragMoved.current=Math.abs(e.clientX-drag.originX)+Math.abs(e.clientY-drag.originY)>10;setDrag({...drag,x:e.clientX,y:e.clientY});const handTop=document.querySelector('.hand-area')?.getBoundingClientRect().top||window.innerHeight-173;setHoverDrop(drag.fromTable?e.clientY>=handTop:e.clientY<handTop)}
 async function dragEnd(event?:React.PointerEvent){if(event?.type==='pointercancel'){setDrag(null);setHoverDrop(false);return false}if(!drag)return false;const accepted=(dragMoved.current&&hoverDrop)||!dragMoved.current;setDrag(null);setHoverDrop(false);if(!accepted)return false;if(drag.fromTable)return returnCard(drag.resource);stageCard(drag.resource);return true}
 function selectBuild(kind:string){setTableMode(null);if(!specialPlacement&&!buildOptions[kind as keyof typeof buildOptions]){say(phaseNotice||(!mine?'请等待你的行动回合，桌面资源会保留。':kind==='development'?'发展卡库存不足，或桌面费用尚未备齐。':'当前没有合法的建造位置，或对应棋子已用完。'));return;}if(kind==='development'){setPendingBuild({kind,action:{type:'buyDevelopment'}});return}setReturnView(view);setView('overhead');setBuilding(true);setTool(kind);sound('card1')}
 function placeBuild(action:BuildAction){
  if(busy||pendingBuild)return;
  if(phase==='road_building'){void act(action);return}
  const kind=action.type==='buildRoad'?'road':action.type==='buildCity'?'city':'settlement';
  if(setupPlacement){
   if(!mine||!isLegalSetupPlacement(action))return;
   setTableMode(null);
   setPendingBuild({kind,action,setup:{phase,step:game.setupStep,playerId}});
  }else{
   if(!buildOptions[kind]){say('请先把建造所需资源放到桌面。');return}
   setPendingBuild({kind,action});
  }
  sound('build1');
 }
 function isLegalSetupPlacement(action:BuildAction){
  return phase==='setup_settlement'&&action.type==='buildSettlement'&&canVertices.includes(action.vertexId)
   ||phase==='setup_road'&&action.type==='buildRoad'&&canEdges.includes(action.edgeId);
 }
 async function confirmBuild(){
  if(!pendingBuild||busy)return;
  const {kind,action,setup}=pendingBuild;
  const valid=setup?mine&&isLegalSetupPlacement(action):buildOptions[kind];
  if(!valid){setPendingBuild(null);say('当前可建位置或桌面资源已变化，请重新选择。');return}
  const remainder=setup?staged:spendStagedBuild(staged,kind);
  if(await act(action)){if(!setup)setStaged(remainder);setPendingBuild(null);setTableMode(null)}
 }
 function openTableTrade(mode:string){if(mode==='port'&&!portQuote.valid&&mixedQuote.valid)setPortMixed(true);setTableMode(mode);setReceiveCards(blank());setPendingBuild(null);if(mode!=='players')setTableTradeId(null);sound('card1')}
 function chooseTrader(id:string){if(id===playerId||pendingBuild?.setup)return;setTradeTarget(id);setPendingBuild(null);const incoming=tableTrades.find(t=>t.from===id&&t.to===playerId)||tableTrades.find(t=>t.from===id&&!t.to);if(incoming){setTableTradeId(incoming.id);setTableMode('players');const own=incoming.to===playerId?incoming.response:null;setStaged(own?reconcileStaged(hand,own):blank())}else{setTableTradeId(null);setTableMode('players')}sound('card1')}
 function selectTable(t:any){setTableTradeId(t.id);setTradeTarget(t.from===playerId?(t.to||''):t.from);setTableMode('players');const own=t.from===playerId?t.give:t.response;setStaged(own?reconcileStaged(hand,own):blank());sound('card1')}
 async function submitTableOffer(){let action:any;if(activeTable){if(activeTable.from!==playerId&&(!activeTable.to||activeTable.response===null))action={type:'respondTableTrade',tradeId:activeTable.id,give:staged};else action={type:'updateTableTrade',tradeId:activeTable.id,give:staged};}else action={type:'createTableTrade',targetId:tradeTarget||undefined,give:staged};const result=await act(action);if(result){const latest=(result.tableTrades||[]).find((t:any)=>action.type==='respondTableTrade'&&!activeTable?.to?t.parentId===action.tradeId&&t.to===playerId:action.type==='createTableTrade'?t.id===`table${result.actionSequence}`:t.id===action.tradeId);if(latest)setTableTradeId(latest.id);say('报价已摆好。双方确认后才会交换资源。')}}
 async function confirmTable(){if(!activeTable||!offerMatches){say('牌面已更换，请先更新报价，双方再重新确认。');return}const result=await act({type:'confirmTableTrade',tradeId:activeTable.id});if(result?.tableTradeResult?.tradeId===activeTable.id){setStaged(blank());setTableTradeId(null);setTableMode(null)}}
 async function confirmMaritime(){const result=await act({type:'maritimeTrade',mode:tableMode,mixed:tableMode==='port'&&portMixed,give:staged,get:receiveCards});if(result){setStaged(blank());setReceiveCards(blank());setTableMode(null)}}
 async function confirmDiscard(){const burned={...staged};const result=await act({type:'discard',resources:staged});if(result){setBurnCards(burned);setStaged(blank());setTimeout(()=>setBurnCards(null),1400)}}

 const anyBuild=Object.values(affordableBuild).some(Boolean);
 const pendingRobberTargets:string[]=pendingRobber?(legal.robberChoices?.[pendingRobber.tileId]||[]):[];
 function previewRobber(tileId:any){if(busy||!legal.robberTiles?.includes(tileId))return;const targets:string[]=legal.robberChoices?.[tileId]||[];setPendingRobber({tileId,targetId:targets.length===1?targets[0]:null});setTableMode(null);sound('card1')}
 async function confirmRobber(){if(!pendingRobber)return;const result=await act({type:'confirmRobber',tileId:pendingRobber.tileId,targetId:pendingRobber.targetId||undefined});if(result)setPendingRobber(null)}
 const quote=tableMode==='port'?portQuote:bankQuote;
 const playerOfferValid=game?.options?.allowGifts||total(staged)>0;
 const tradeIncludesCurrent=activeTable?(activeTable.from===game?.activePlayerId||activeTable.to===game?.activePlayerId):(mine||!tradeTarget||tradeTarget===game?.activePlayerId);
 const playerTradeNotice=!legal.canOfferTrade?(phaseNotice||(game?.turnKind==='paired'?'配对第二行动阶段不能与玩家交易':'特殊建造阶段不能交易')):!tradeIncludesCurrent?`交易需要包含当前行动玩家，请选择 ${active?.name||'当前玩家'}。`:'';
 const emptyTradeNotice=total(staged)===0?(game?.options?.allowGifts?'本局允许赠牌：可空手发出请求，等对方摆牌后双方确认。':'本局未开启赠牌。可以先选择交易对象，摆出至少一张资源后发出报价。'):'';
 const resourceCards=total(hand)>0?RES:[];
 const radialControl=<RadialActions buildEnabled={specialPlacement?mine:anyBuild} tradeEnabled={total(staged)>0||!!tradeTarget||!!activeTable||!!game?.options?.allowGifts} buildOptions={specialPlacement?{road:phase!=='setup_settlement',settlement:phase==='setup_settlement',city:false,development:false}:affordableBuild} bankEnabled={bankQuote.valid} portEnabled={portQuote.valid||mixedQuote.valid} playersEnabled={true} status={phaseNotice} onBuild={selectBuild} onTrade={openTableTrade} disabled={busy||!!pendingBuild||phase==='discard'}/>;
 function openPractice(){
  if(!practice){freshPractice(size>4);return}
  setShowPractice(true);setModal(null);
 }
 function copyInvite(roomCode:string){
  const inviteUrl=new URL('/',location.origin);
  inviteUrl.searchParams.set('room',roomCode);
  if(!navigator.clipboard){say('邀请码：'+roomCode);return}
  navigator.clipboard.writeText(inviteUrl.href).then(()=>say('邀请链接已复制')).catch(()=>say('邀请码：'+roomCode));
 }
 function cancelRoomRecovery(){
  setAuth(null);setRoom(null);setConnected(true);localStorage.removeItem('tidal-room');
 }
 function returnFromResults(){
  setModal(null);
  setShowPractice(false);
  setTab('create');
  setCode('');
  setToast('');
  setBuilding(false);
  setTool('');
  setTradeTarget('');
  setDrag(null);
  setHoverDrop(false);
  lastDice.current='';
  lastTableReset.current=null;
  if(room){
   cancelRoomRecovery();
  }else{
   setPractice(null);
   sessionStorage.removeItem('tidal-practice-v1');
  }
  const url=new URL(location.href);
  if(url.searchParams.has('room')){
   url.searchParams.delete('room');
   history.replaceState(history.state,'',url);
  }
 }
 return <>
  {showLobby?<VoyageLobby room={room} playerId={playerId} restoring={!ready||!!auth&&!room} connected={connected} busy={busy}
   mode={tab} setMode={setTab} name={name} setName={setName} code={code} setCode={setCode}
   size={size} setSize={setSize} rule={rule} setRule={setRule} flags={ruleFlags} setFlags={setRuleFlags}
   onRoomAction={roomAction} onEditRules={editRoomRules} onCopyInvite={copyInvite}
   onPractice={openPractice} hasPractice={!!practice} onRules={()=>setModal('rules')} onCancelRecovery={cancelRoomRecovery}/>
  :<div className={'app '+(view==='table'?'table-view ':'')+(building?'construction-mode ':'')+(players.length>4?'expanded-game ':'')+(layoutMode==='minimal'?'layout-minimal':'layout-dashboard')}>
  <header className="topbar"><a className="brand" href="/" aria-label="潮汐群岛主页"><span className="brand-mark"><Waves size={24}/></span><span>CATAN<small>潮 汐 群 岛</small></span></a><div className="session-tag"><span className="live-dot"/> {isPractice?'本机练习':`房间 ${room?.code||auth?.code}`}<span className="tag-divider"/> {game?.options?.expanded||room?.options?.expanded?'5–6 人扩展':'经典 · 3–4 人'} <ChevronDown size={13}/></div><nav><button className="plain" onClick={()=>setModal('rules')}><BookOpen size={16}/>规则手册</button><button className="icon-btn" title={muted?'开启声音':'关闭声音'} onClick={()=>setMuted(!muted)}>{muted?<VolumeX size={18}/>:<Volume2 size={18}/>}</button><button className={'icon-btn '+(ruleVotePending?'settings-vote-dot':'')} title={ruleVotePending?'游戏设置 · 有规则提案':'游戏设置'} onClick={()=>setModal(ruleVotePending?'rule-voting':'settings')}><Settings2 size={18}/></button><button className="invite" onClick={()=>{if(room)setModal('invite');else{setPendingBuild(null);setShowPractice(false)}}}><Users size={16}/>{room?'邀请好友':'联机大厅'}<ArrowRight size={15}/></button></nav></header>
  <main className="game-layout">
   <aside className="players-panel"><div className="section-eyebrow">THE EXPLORERS <span>{players.length} 位开拓者</span></div><h1>向岛屿出发<span>每一次选择，都是新的航线。</span></h1><div className="player-list">{players.map((p:any,i:number)=><div key={p.id} role="button" tabIndex={0} onClick={()=>chooseTrader(p.id)} onKeyDown={e=>{if(e.key==='Enter')chooseTrader(p.id)}} className={'player '+(p.id===game?.activePlayerId?'active ':'')+(tradeTarget===p.id?'trade-selected':'')} style={{'--player':p.color} as React.CSSProperties}><div className="player-avatar">{i===0?<Crown size={20}/>:i===1?<Anchor size={20}/>:i===2?<Flag size={20}/>:<Waves size={20}/>}</div><div className="player-info"><strong>{p.name}{p.id===playerId&&<small>你</small>}</strong><div><span>▰ {p.resourceCount??total(p.resources)}</span><span title="持有的发展卡数量" aria-label={`发展卡 ${p.developmentCount??(p.developmentCards||[]).length} 张`}>▥ {p.developmentCount??(p.developmentCards||[]).length}</span>{tableTrades.some(t=>t.from===p.id&&!t.to)?<em>公开报价</em>:p.id===game?.activePlayerId&&<em>行动中</em>}</div></div>{Number(p.playedKnights)>0&&<div className="player-army" title={`已使用 ${p.playedKnights} 张士兵牌`} aria-label={`已使用 ${p.playedKnights} 张士兵牌`}><Swords className="player-army-swords" size={34} strokeWidth={1.5}/><Shield className="player-army-shield" size={22} strokeWidth={1.8}/><b>{p.playedKnights}</b></div>}<div className="score">{p.totalPoints??p.score??p.points??p.publicPoints??p.victoryPoints??0}<small>VP</small></div></div>)}</div>
    <div className="goal-box"><div><Flag size={17}/><span>通往胜利</span><b>10 <small>VP</small></b></div><p>拓展道路，建立聚落。<br/>第一个在自己回合达到 10 分的玩家获胜。</p></div>
    <div className="awards"><div><Route size={19}/><span>最长道路<small>至少 5 条连续道路</small></span><b>+2</b></div><div><Shield size={19}/><span>最大骑士<small>至少打出 3 张骑士</small></span><b>+2</b></div></div>
    <div className="connection"><span className={'live-dot '+(!connected?'offline':'')}/>{isPractice?'本机轮流操作 · 安全随机':connected?'联机已同步 · 隐藏手牌':'连接中断 · 正在重试'}<small>{isPractice?'正式联机使用大气噪声随机骰子':'状态由服务器校验与保存'}</small></div>
   </aside>
   <section className="island-panel"><div className="board-toolbar"><div className="view-switch"><button className={view==='overhead'?'selected':''} onClick={()=>{setView('overhead');sound()}}><Layers size={15}/>俯瞰视角</button><button className={view==='table'?'selected':''} onClick={()=>{setView('table');sound()}}><Maximize2 size={15}/>桌边视角</button></div>{building?<button className="close-building" disabled={busy} onClick={closeBuilding}><X size={14}/>收起地图</button>:<span className="map-label">THE TIDAL ISLANDS <span>✧</span></span>}</div>
    {building&&<div className="construction-toolbar"><div className="construction-title"><Hammer size={19}/><span>{String(phase).startsWith('setup')?'初始放置 · 蛇形顺序':'建造你的岛屿'}<small>选择建筑，再点击地图上的 ＋</small></span></div><div className="construction-choices">{[{id:'road',title:'道路',icon:Route,cost:['wood','brick']},{id:'settlement',title:'村庄',icon:House,cost:['wood','brick','sheep','wheat']},{id:'city',title:'城市',icon:Crown,cost:['wheat','wheat','ore','ore','ore']}].map(item=><button className={effectiveTool===item.id?'selected':''} key={item.id} disabled={!!pendingBuild||(String(phase).startsWith('setup')?(item.id!==(phase==='setup_settlement'?'settlement':'road')):phase==='road_building'?item.id!=='road':!buildOptions[item.id as keyof typeof buildOptions])} onClick={()=>chooseTool(item.id)}><item.icon size={21}/><span>{item.title}</span><div className="cost">{item.cost.map((r,i)=><i key={i} style={{background:COLORS[r]}} title={LABEL[r]}/>)}</div></button>)}<button disabled={!buildOptions.development||busy||!!pendingBuild} onClick={()=>selectBuild('development')}><ScrollText size={21}/><span>发展卡</span><div className="cost">{['sheep','wheat','ore'].map(r=><i key={r} style={{background:COLORS[r]}}/>)}</div></button></div><button className="undo-build" disabled={!legal.canUndoBuild||busy||!!pendingBuild} onClick={()=>act({type:'undoBuild'})}><RotateCcw size={16}/>撤销</button></div>}
    <div className="board-stage"><div className="sea-rings"/><div className="compass"><span>N</span><div>✧</div></div><div className="ocean-label left">苍 蓝 海 域</div><div className="ocean-label right">驶 向 未 知</div>
     <div className="board-world" style={{transform:view==='table'?`perspective(1100px) rotateX(39deg) rotateZ(${angle}deg) scale(1.02)`:`perspective(1100px) rotateX(0deg) rotateZ(0deg)`}}>
     <svg className="island" viewBox={`${minX} ${minY} ${maxX-minX} ${maxY-minY}`} role="group" aria-label="卡坦六角棋盘，可点击高亮交点建村、边建路">
      <defs><filter id="landShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="11" stdDeviation="5" floodColor="#001919" floodOpacity=".65"/></filter><filter id="pieceShadow"><feDropShadow dx="1" dy="3" stdDeviation="1.5" floodOpacity=".45"/></filter><pattern id="seaPattern" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M0 14 Q7 9 14 14 T28 14" fill="none" stroke="#4a7a7b" strokeOpacity=".2"/></pattern></defs>
      <g filter="url(#landShadow)">{tiles.map((t:any)=>{const {x,y}=tilexy(t);const hex=Array.from({length:6},(_,i)=>{const a=(60*i-30)*Math.PI/180;return `${x+62*Math.cos(a)},${y+62*Math.sin(a)}`}).join(' ');return <g key={t.id} className={'hex '+(phase==='robber'&&legal.robberTiles?.includes(t.id)?'robber-target ':'')+(pendingRobber?.tileId===t.id?'robber-selected':'')} onClick={()=>{if(phase==='robber')previewRobber(t.id)}}><polygon points={hex} fill={COLORS[t.resource]||COLORS.desert} stroke="#e6d7ac" strokeWidth="3"/><polygon points={Array.from({length:6},(_,i)=>{const a=(60*i-30)*Math.PI/180;return `${x+54*Math.cos(a)},${y+54*Math.sin(a)}`}).join(' ')} fill="none" stroke="#fff" strokeOpacity=".12"/><Terrain resource={t.resource} x={x} y={y}/>{t.number>0&&<g className="number-token" transform={`translate(${x},${y+15})`}><circle r="20" fill="#f4e9cb" stroke="#e1cfa8" strokeWidth="2"/><text textAnchor="middle" y="4" className={[6,8].includes(t.number)?'hot':''}>{t.number}</text><text className={'probability '+([6,8].includes(t.number)?'hot':'')} textAnchor="middle" y="13">{'•'.repeat(6-Math.abs(7-t.number))}</text></g>}{(robberId===t.id||String(robberId)===String(t.id))&&<g className={pendingRobber?'robber-preview-piece':''} transform={`translate(${x+25},${y-10})`} filter="url(#pieceShadow)"><path d="M-9 10 L-6 -5 Q-13 -20 0 -22 Q13 -20 6 -5 L9 10Z" fill="#263d3e" stroke="#f6e9c9" strokeWidth="1.5"/><ellipse cy="11" rx="11" ry="4" fill="#1b3032"/></g>}</g>})}</g>
      {ports.map((p:any,i:number)=>{const vs=(p.vertices||p.vertexIds||[]).map((id:string)=>vertexMap[id]).filter(Boolean);if(vs.length<2)return null;const a=point(vs[0]),b=point(vs[1]);const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,l=Math.hypot(mx,my)||1;const x=mx+mx/l*43,y=my+my/l*43;return <g key={'port'+i} className="port-marker" role="button" tabIndex={0} aria-label={`${p.resource?LABEL[p.resource]+'专门':'通用'}港口 ${p.ratio|| (p.resource?2:3)} 比 1，点击查看`} onClick={()=>{setSelectedPort(p);setModal('port');sound('card1')}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelectedPort(p);setModal('port');sound('card1')}}}><path d={`M${a.x},${a.y} L${x},${y} L${b.x},${b.y}`} fill="none" stroke="#cbb98c" strokeWidth="3"/><circle cx={x} cy={y} r="24" fill="#153e47" stroke="#b8a575" strokeWidth="1.5"/><circle cx={x} cy={y} r="20" fill="none" stroke="#b8a575" strokeOpacity=".18"/>{p.resource&&<image href={`/assets/${p.resource}.svg`} x={x-11} y={y-19} width="22" height="22"/>}<text x={x} y={y+(p.resource?16:5)} textAnchor="middle" fill="#f0dfb7" fontSize={p.resource?13:16} fontWeight="600">{p.ratio|| (p.resource?2:3)}:1</text><title>{p.resource?LABEL[p.resource]+'专门':'通用'}港口 · 点击查看</title></g>})}
      {edges.map((e:any)=>{const va=vertexMap[e.a],vb=vertexMap[e.b];if(!va||!vb)return null;const a=point(va),b=point(vb),can=!pendingBuild&&(specialPlacement||buildOptions.road)&&effectiveTool==='road'&&canEdges.includes(e.id);return <g key={e.id}>{e.owner&&<g className={'road-piece '+(pendingBuild?.setup&&pendingBuild.action.edgeId===e.id?'setup-preview-piece':'')} transform={`translate(${(a.x+b.x)/2},${(a.y+b.y)/2}) rotate(${Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI})`}><rect x={-Math.hypot(b.x-a.x,b.y-a.y)*.33} y="-5" width={Math.hypot(b.x-a.x,b.y-a.y)*.66} height="10" rx="3" fill={ownerColor(e.owner)} stroke="#243d3d" strokeWidth="1.8"/><path d={`M${-Math.hypot(b.x-a.x,b.y-a.y)*.27},-2 H${Math.hypot(b.x-a.x,b.y-a.y)*.27}`} stroke="#fff" strokeOpacity=".28" strokeWidth="1.4"/></g>}{can&&<><line className="build-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} onClick={()=>placeBuild({type:'buildRoad',edgeId:e.id})}><title>在此建造道路</title></line><g className="build-vertex road-plus" role="button" tabIndex={0} aria-label={phase==='road_building'?'在此建造免费道路':'在此预览道路'} onKeyDown={eKey=>{if(eKey.key==='Enter'||eKey.key===' '){eKey.preventDefault();placeBuild({type:'buildRoad',edgeId:e.id})}}} transform={`translate(${(a.x+b.x)/2},${(a.y+b.y)/2})`} onClick={()=>placeBuild({type:'buildRoad',edgeId:e.id})}><circle r="10"/><path d="M-4 0H4M0 -4V4"/></g></>}</g>})}
      {vertices.map((v:any)=>{const {x,y}=point(v),can=!pendingBuild&&(specialPlacement||buildOptions[effectiveTool as 'settlement'|'city'])&&['settlement','city'].includes(effectiveTool)&&canVertices.includes(v.id);return <g key={v.id} transform={`translate(${x},${y})`}>{v.owner&&<g className={pendingBuild?.setup&&pendingBuild.action.vertexId===v.id?'setup-preview-piece':undefined} filter="url(#pieceShadow)"><path d={v.level===2?'M-13 8V-5L-6 -12L1 -5V-11L8 -17L15 -10V8Z':'M-10 8V-6L0 -15L10 -6V8Z'} fill={ownerColor(v.owner)} stroke="#493b29" strokeWidth="2"/><path d="M0 8V-1H5V8" fill="#483e30" opacity=".5"/></g>}{can&&<g className="build-vertex" role="button" tabIndex={0} aria-label={effectiveTool==='city'?'在此预览城市':'在此预览村庄'} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();placeBuild({type:effectiveTool==='city'?'buildCity':'buildSettlement',vertexId:v.id})}}} onClick={()=>placeBuild({type:effectiveTool==='city'?'buildCity':'buildSettlement',vertexId:v.id})}><circle r="13"/><path d="M-5 0H5M0 -5V5"/><title>在此{effectiveTool==='city'?'升级城市':'建立村庄'}</title></g>}</g>})}
     </svg></div>
     {!building&&!tableMode&&!pendingBuild&&phase!=='discard'&&tableTrades.filter(t=>t.from!==playerId||t.to).length>0&&<div className="table-invitations">{tableTrades.filter(t=>t.from!==playerId||t.to).slice(-3).map(t=><button key={t.id} onClick={()=>selectTable(t)}><Trade size={14}/><span>{players.find(p=>p.id===(t.from===playerId?t.to:t.from))?.name}{!t.to?'的公开报价':' · 交易邀请'}</span><ArrowRight size={13}/></button>)}</div>}
     {tableMode&&phase!=='discard'&&!pendingBuild&&<div className="table-context"><button className="table-context-close" title="收起交易提示" onClick={()=>{setTableMode(null);if(isPractice){setPracticeViewer(null);setTradeTarget('')}}}><X size={15}/></button>{tableMode==='players'?<><div className="table-context-heading"><Trade size={17}/><b>{activeTable?.to?`与 ${otherTrader?.name||'玩家'} 交换`:tradeTarget?`向 ${otherTrader?.name||'玩家'} 发起交易`:'公开报价'}</b>{tradeTarget&&!activeTable&&<button onClick={()=>setTradeTarget('')}>改为公开</button>}</div>{activeTable?.from===playerId&&!activeTable.to&&tableTrades.filter(t=>t.parentId===activeTable.id).length>0&&<div className="table-responses">{tableTrades.filter(t=>t.parentId===activeTable.id).map(t=><button key={t.id} onClick={()=>selectTable(t)}><span>{players.find(p=>p.id===t.to)?.name} 已回应</span><span>{RES.filter(r=>t.response?.[r]>0).map(r=>`${t.response[r]} ${LABEL[r]}`).join(' · ')||'赠牌请求'}</span><ArrowRight size={14}/></button>)}</div>}{otherOffer?<ResourceOffer resources={otherOffer} title={`${otherTrader?.name||'对方'} 给出`} confirmed={activeTable?.confirmed?.includes(otherTrader?.id)} subtitle="这是对方提交的报价，桌面仍只有你的牌"/>:<p className="table-context-note">{activeTable?.from===playerId?'等待其他玩家摆出资源。':'点击玩家名字可指定对象；不选择对象则公开报价。'}</p>}{(playerTradeNotice||emptyTradeNotice)&&<p className="table-context-note action-notice">{playerTradeNotice||emptyTradeNotice}</p>}{activeTable?.to&&myOffer&&<div className="table-my-offer">{offerMatches?'你的桌面与已提交报价一致':'你的牌已更换，更新报价后双方需要重新确认'}<span>{activeTable.confirmed.includes(playerId)?'你已确认':'你未确认'}</span></div>}<div className="table-context-buttons"><button className="table-secondary" disabled={busy||!!playerTradeNotice||!playerOfferValid} onClick={submitTableOffer}>{activeTable?(myOffer?'更新报价':'摆好我的牌'):total(staged)===0&&game?.options?.allowGifts?'请求赠牌':'发出报价'}<ArrowRight size={13}/></button>{activeTable?.to&&activeTable.response!==null&&<button className="table-confirm" disabled={busy||!!playerTradeNotice||!offerMatches||activeTable.confirmed.includes(playerId)} onClick={confirmTable}><Check size={14}/>{activeTable.confirmed.includes(playerId)?'已确认，等待对方':'确认交换'}</button>}{activeTable&&<button className="table-decline" disabled={busy} onClick={async()=>{if(await act({type:'rejectTableTrade',tradeId:activeTable.id})){setTableMode(null);setTableTradeId(null);setStaged(blank())}}}>取消</button>}</div>{isPractice&&activeTable?.to&&<button className="practice-seat" onClick={()=>{const nextId=activeTable.from===playerId?activeTable.to:activeTable.from;setPracticeViewer(nextId);setStaged(blank())}}>本机练习 · 切到 {otherTrader?.name} 的席位</button>}</>:<><div className="table-context-heading"><Anchor size={17}/><b>{tableMode==='bank'?'银行兑换':'港口兑换'}</b><span>{quote.valid?`桌面资源可换 ${quote.receiveCount} 张`:'调整桌面资源以满足比例'}</span></div>{tableMode==='port'&&game?.options?.mixedPortTrade&&legal.hasGenericPort&&<div className="table-port-toggle"><button className={!portMixed?'selected':''} onClick={()=>{setPortMixed(false);setReceiveCards(blank())}}>同类分组</button><button className={portMixed?'selected':''} onClick={()=>{setPortMixed(true);setReceiveCards(blank())}}>混合 3:1</button></div>}{!legal.canTrade&&<p className="table-context-note action-notice">{phaseNotice||(!mine?'银行和港口兑换需在你的行动回合进行。':'特殊建造阶段不能交易。')}</p>}{quote.valid?<ResourcePicker value={receiveCards} onChange={setReceiveCards} maxTotal={quote.receiveCount} blockedResources={RES.filter(r=>staged[r]>0)} bank={game?.bank} infinite={!!game?.options?.infiniteBank}/>:<p className="table-context-note">{quote.reason}</p>}<div className="table-context-buttons"><button className="table-confirm" disabled={busy||!legal.canTrade||!quote.valid||total(receiveCards)!==quote.receiveCount} onClick={confirmMaritime}><Check size={14}/>确认兑换 {total(receiveCards)} / {quote.receiveCount||0}</button><button className="table-secondary" onClick={()=>{setTableMode(null);reviseStaged(blank())}}>拿回手牌</button></div></>}</div>}
     {pendingBuild&&<div className="build-confirmation"><Hammer size={21}/><div><b>{pendingBuild.kind==='development'?'购买发展卡':pendingBuild.kind==='road'?'道路位置已选好':pendingBuild.kind==='city'?'城市位置已选好':'村庄位置已选好'}</b><span>{pendingBuild.setup?'仅预览 · 撤销后可重选位置':'尚未支付资源 · 拖回牌或点撤销可重新选择'}</span></div><button className="table-secondary" disabled={busy} onClick={()=>setPendingBuild(null)}><RotateCcw size={14}/>撤销</button><button className="table-confirm" disabled={busy} onClick={confirmBuild}><Check size={14}/>确认建造</button></div>}
     {phase==='robber'&&mine&&!tableMode&&<section className="robber-confirmation" aria-label="强盗移动确认"><div className="table-context-heading"><Shield size={18}/><b>{pendingRobber?'强盗位置预览':'移动强盗'}</b></div><p>{pendingRobber?'尚未移动或偷牌，可换格子或撤销。':'点击一块高亮地形预览位置，再确认。'}</p>{pendingRobber&&<>{pendingRobberTargets.length>0?<div className="robber-target-choices">{pendingRobberTargets.map(id=><button key={id} disabled={busy} className={pendingRobber.targetId===id?'selected':''} onClick={()=>setPendingRobber({...pendingRobber,targetId:id})}>{players.find(p=>p.id===id)?.name}<small>随机偷取 1 张资源</small></button>)}</div>:<p className="robber-no-target">此处没有可偷取的资源，只移动强盗。</p>}<div className="table-context-buttons"><button className="table-secondary" disabled={busy} onClick={()=>{setPendingRobber(null);sound('card1')}}><RotateCcw size={13}/>撤销移动</button><button className="table-confirm" disabled={busy||(pendingRobberTargets.length>0&&!pendingRobber.targetId)} onClick={confirmRobber}><Check size={14}/>{pendingRobberTargets.length?'确认移动并偷牌':'确认移动'}</button></div><small className="robber-final-note">确认后不可撤销</small></>}</section>}
     {phase==='discard'&&<div className="table-discard-context"><span>强盗来袭</span><b>{legal.discardCount?`请将 ${legal.discardCount} 张资源拖到桌面`:'等待其他玩家弃牌'}</b><small>所有未提交的桌面牌已经返回手中</small>{legal.discardCount>0&&<button className="table-confirm burn-confirm" disabled={busy||!canDiscard(staged,legal.discardCount)} onClick={confirmDiscard}>确认弃置 {total(staged)} / {legal.discardCount}</button>}</div>}
     {layoutMode==='dashboard'&&(!specialPlacement||burnCards)&&<div className={'table-cards-anchor '+(building?'during-building':'')}><TableCards staged={burnCards||staged} onReturn={returnCard} onClear={()=>reviseStaged(blank())} burning={!!burnCards} disabled={busy} onDragStart={(e,r)=>dragStart(e,r,true)} onDragMove={dragMove} onDragEnd={dragEnd}/></div>}
     <div className="minimal-scattered-anchor" hidden={layoutMode!=='minimal'||(!total(staged)&&!burnCards)}><ScatteredCards key={playerId} staged={burnCards||staged} onReturn={returnCard} onClear={()=>reviseStaged(blank())} burning={!!burnCards} disabled={busy} onDragStart={(e,r)=>dragStart(e,r,true)} onDragMove={dragMove} onDragEnd={dragEnd}/></div>
     <FloatingActions visible={layoutMode==='minimal'&&total(staged)>0&&!tableMode&&!pendingBuild&&!pendingRobber&&!building&&phase!=='discard'}>{radialControl}</FloatingActions>
     {view==='table'&&<div className="camera-controls"><button title="向左环绕" onClick={()=>{setAngle(angle-60);sound()}}><ChevronLeft size={21}/></button><span>桌边座位 · {(((-angle/60)%6)+6)%6+1}</span><button title="向右环绕" onClick={()=>{setAngle(angle+60);sound()}}><ChevronRight size={21}/></button></div>}
     {drag&&<div className={'drop-zone '+(hoverDrop?'over':'')}><Layers size={24}/><b>{drag?.fromTable?'拿回手牌':'把牌放到你的桌面'}</b><span>{phase==='discard'?'放好要弃置的牌，再点击确认':'确认前可以随时更换 · 其他人看不到桌面牌'}</span></div>}

    </div>
    <div className="turn-strip"><span className="turn-dot"/><div><b>{mine?'轮到你了':`${active?.name||'准备'}的回合`}</b><span>{game?.options?.flexibleRoll&&legal.canRoll?'自由行动 · 本回合尚未掷骰':pLabel[phase]||'等待好友加入'}{String(phase).startsWith('setup')?' · 点击 ＋ 自选位置':''}{game?.turnKind==='paired'?' · P2 配对行动':game?.turnKind==='special'?' · 特殊建造':''}{effectiveTool&&phase==='actions'?' · 点击棋盘高亮位置':''}</span></div><span className="round-number">ROUND {String(Math.max(1,Math.ceil((game?.turn||1)/players.length))).padStart(2,'0')}</span></div>
   </section>
   <aside className="action-panel"><div className="panel-heading"><span>本回合</span><span>✦</span></div><div className="dice-area"><span className="eyebrow">LET FATE SET SAIL</span><div className="dice-row"><Dice n={dice[0]||1} rolling={rolling}/><Dice n={dice[1]||1} rolling={rolling}/></div><div className="dice-caption">{legal.canRoll?'让命运扬帆':`点数 ${(dice[0]||0)+(dice[1]||0)} · ${phase==='discard'||phase==='robber'?'强盗来袭':'岛屿苏醒'}`}</div><button className="gold-button roll-button" disabled={!legal.canRoll||busy} onClick={()=>act({type:'roll'})}><Dices size={18}/>{rolling?'骰子滚动中…':'投掷骰子'}</button><small className="rng-label"><Shield size={11}/>{isPractice?'练习局 · 浏览器安全随机':'RANDOM.ORG · 大气噪声随机'}</small></div>
    <div className="build-section table-action-section"><div className="section-eyebrow">桌面行动</div>{layoutMode==='dashboard'?<>{radialControl}<p className="table-action-help">{pendingBuild?'确认上方的建造，或撤销重新选择。':specialPlacement?'初始放置免费，点击地图 ＋ 选择位置，再确认。':total(staged)?'已放好的资源会点亮可用行动。':'先把手中的资源牌拖到地图上。'}</p><button className="undo-build" disabled={!legal.canUndoBuild||busy} onClick={()=>act({type:'undoBuild'})}><RotateCcw size={14}/>撤销已提交建造</button></>:<><StagingSummary staged={staged}/>{legal.canUndoBuild&&<button className="undo-build minimal-undo" disabled={busy} onClick={()=>act({type:'undoBuild'})}><RotateCcw size={13}/>撤销上次建造</button>}</>}</div>
    <section className="journal" aria-labelledby="journal-title">
     <h2 className="section-eyebrow" id="journal-title">航海日志 <ScrollText size={13} aria-hidden="true"/></h2>
     <div className="log-scroll" role="region" aria-label="航海日志记录" tabIndex={0}>
      <ol className="log-list">{(game?.log||game?.logs||['欢迎来到潮汐群岛。','点击高亮交点，选择你的第一座村庄。']).slice().reverse().map((entry:any,index:number,entries:any[])=>{
       const text=typeof entry==='string'?entry:entry.message||entry.text;
       const key=typeof entry==='string'||entry.id==null?`legacy-${entries.length-index}`:JSON.stringify([entry.id,text]);
       return <li key={key}><span className="log-dot" aria-hidden="true"/><p>{text}</p></li>;
      })}</ol>
     </div>
    </section>
    <button className="end-turn" disabled={!legal.canEndTurn||busy} onClick={()=>act({type:'endTurn'})}>结束回合 <ArrowRight size={17}/></button>
   </aside>
  </main>
  <footer className="hand-area"><div className="hand-summary"><span>你的手牌 <b>{total(usableHand)}</b></span><small>{isPractice?'随回合切换玩家 · 本机练习':'只有你能看见这些资源'}</small><button disabled={busy||!!burnCards} onClick={()=>{reviseStaged(blank());setTableMode(null);if(isPractice){setPracticeViewer(null);setTradeTarget('')}}}><RotateCcw size={15}/>全部拿回</button></div><div className="cards">{resourceCards.length?resourceCards.map((r,i)=><button key={r} className={'resource-card '+(drag?.resource===r?'drag-origin':'')+(!(usableHand[r]>0)?' zero-card':'')} style={{'--card':COLORS[r],'--rotate':`${(i-(resourceCards.length-1)/2)*5}deg`,'--rise':`${Math.abs(i-(resourceCards.length-1)/2)*6}px`} as React.CSSProperties} onPointerDown={e=>{if(usableHand[r]>0)dragStart(e,r)}} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={()=>setDrag(null)} onKeyDown={e=>{if(e.key==='Enter')stageCard(r)}}><div className="card-top"><span>RESOURCE</span><b>×{usableHand[r]||0}</b></div><div className="card-art"><Icon name={r} size={66}/><span className="art-halo"/></div><strong>{LABEL[r]}</strong><small>{r.toUpperCase()}</small></button>):<div className="empty-hand"><Layers size={28}/><span>岛屿的馈赠，正在路上<small>放置第二座村庄后，获得相邻地形的资源</small></span></div>}</div><div className="hand-right"><button className="development-stack" onClick={()=>setModal('development')}><Sparkles size={23}/><span>发展卡 <b>{developments.length}</b></span></button><span className="drag-tip">拖到桌面 · 确认前可拿回</span></div></footer>
  {phase==='steal'&&mine&&<div className="steal-box"><b>选择偷取对象</b>{list('stealTargets','victims').map((id:string)=><button key={id} onClick={()=>act({type:'steal',targetId:id})}>{players.find(p=>p.id===id)?.name}</button>)}</div>}
  {showingResults&&<div className="victory-overlay"><Crown size={50}/><h2>{players.find(p=>p.id===game.winner)?.name||'开拓者'}赢得了航程</h2><p>十点荣耀，一座属于你的岛屿。</p><button className="gold-button" disabled={busy} onClick={returnFromResults}>返回开局页</button></div>}
  {drag&&dragMoved.current&&<div className="drag-card" style={{left:drag.x,top:drag.y,background:COLORS[drag.resource]}}><Icon name={drag.resource} size={60}/><b>{LABEL[drag.resource]}</b></div>}
  </div>}
  {toast&&<div className="toast" role="status">{toast}</div>}
  {modal&&!showingResults&&<div className="modal-backdrop" onClick={()=>setModal(null)}><section className={'modal '+(modal==='rules'?'rules-modal':'')} role="dialog" aria-modal="true" aria-label={modal==='rules'?'规则手册':modal==='rule-voting'?'本局规则投票':'游戏操作'} onClick={e=>e.stopPropagation()}><button className="close-modal" title="关闭" onClick={()=>setModal(null)}><X size={20}/></button>
   {modal==='invite'&&room&&<>
    <div className="modal-emblem"><Anchor size={28}/></div><h2>房间邀请码</h2>
    <div className="invite-code">{room.code}</div>
    <button className="gold-button" onClick={()=>copyInvite(room.code)}><Copy size={17}/>复制邀请链接</button>
   </>}

   {modal==='port'&&selectedPort&&<><div className="port-card" style={{'--port-color':selectedPort.resource?COLORS[selectedPort.resource]:'#6c8e8a'} as React.CSSProperties}><div className="port-card-head"><Anchor size={17}/><span>HARBOR OF CATAN</span><b>{selectedPort.ratio}:1</b></div><div className="port-card-art">{selectedPort.resource?<Icon name={selectedPort.resource} size={88}/>:<Anchor size={80}/>}</div><h2>{selectedPort.resource?LABEL[selectedPort.resource]+'专门港':'通用贸易港'}</h2><p>{selectedPort.resource?`每 ${selectedPort.ratio} 张${LABEL[selectedPort.resource]}，换 1 张其他资源。`:'每 3 张同类资源，换 1 张其他资源。'}</p><span className="port-card-rule">{!selectedPort.resource&&game?.options?.mixedPortTrade?'本局额外允许任意 3 张混合兑换':'OFFICIAL MARITIME TRADE'}</span></div><p className="port-access">{selectedPort.vertices.some((id:string)=>vertexMap[id]?.owner===playerId)?<><Check size={16}/>你已拥有这个港口的使用权</>:<><House size={16}/>在相连交点建造村庄或城市，即可使用</>}</p><button className="gold-button" disabled={!selectedPort.vertices.some((id:string)=>vertexMap[id]?.owner===playerId)||!legal.canTrade} onClick={()=>{setPortMixed(false);setModal(null);openTableTrade('port')}}>前往港口交易<ArrowRight size={16}/></button></>}
   {modal==='settings'&&<><span className="eyebrow">MAKE YOURSELF AT HOME</span><h2>桌面设置</h2><button className="setting-row" onClick={()=>setModal('rule-voting')}><span>本局规则投票</span><ArrowRight size={17}/></button><label>操作界面<div className="choice-row layout-mode-choice"><button className={layoutMode==='dashboard'?'selected':''} onClick={()=>{setLayoutMode('dashboard');localStorage.setItem('tidal-layout-mode','dashboard')}}><Layers size={17}/><span>仪表盘<small>固定牌台与操作按钮</small></span></button><button className={layoutMode==='minimal'?'selected':''} onClick={()=>{setLayoutMode('minimal');localStorage.setItem('tidal-layout-mode','minimal')}}><Waves size={17}/><span>极简<small>散落出牌 · 按需浮现</small></span></button></div></label><label>视角<div className="choice-row"><button className={view==='overhead'?'selected':''} onClick={()=>setView('overhead')}>俯瞰岛屿</button><button className={view==='table'?'selected':''} onClick={()=>setView('table')}>坐在桌边</button></div></label><button className="setting-row" onClick={()=>setMuted(!muted)}><span>游戏音效</span><b>{muted?'已关闭':'已开启'}</b></button><button className="setting-row" onClick={()=>freshPractice()}><span>重新开始 4 人本机练习</span><RotateCcw size={17}/></button><button className="setting-row" onClick={()=>freshPractice(true)}><span>开始 5 人扩展练习</span><Users size={17}/></button><button className="text-button" onClick={()=>setModal('credits')}>素材与随机来源</button></>}
   {modal==='rule-voting'&&<><button className="text-button" onClick={()=>setModal('settings')}><ArrowLeft size={14}/>返回桌面设置</button><RuleVoting flags={game?.options||{}} proposal={ruleProposal} players={players} playerId={playerId} practice={isPractice} disabled={busy||(!isPractice&&!connected)} finished={phase==='finished'} onAction={submitRuleAction}/></>}
   {modal==='development'&&<><span className="eyebrow">A LITTLE STRATEGY</span><h2>你的发展卡</h2><p className="modal-sub">每个个人回合最多打出一张非胜利点发展卡。</p>{developments.length?developments.map((c:any)=><button className="dev-item" key={c.id} onClick={()=>{setDevCard(c);setGive('wood');setModal('play-development')}}><ScrollText size={25}/><span>{LABEL[c.type]||c.type}<small>{legal.developmentCards?.includes(c.id)?'可使用 · 点击打出':c.type==='victoryPoint'?'隐藏胜利点 · 自动计分':'下次个人回合可使用'}</small></span><ArrowRight size={17}/></button>):<div className="empty-state"><ScrollText size={36}/><p>你的故事，还未翻开下一章。<br/>用羊毛、麦子和矿石购买发展卡。</p></div>}</>}
   {modal==='play-development'&&devCard&&<><Sparkles size={30}/><h2>{LABEL[devCard.type]||devCard.type}</h2>{['monopoly','yearOfPlenty','year_of_plenty'].includes(devCard.type)&&<label>选择资源<select value={give} onChange={e=>setGive(e.target.value)}>{RES.map(r=><option key={r} value={r}>{LABEL[r]}</option>)}</select></label>}{['yearOfPlenty','year_of_plenty'].includes(devCard.type)&&<label>第二张资源<select value={secondResource} onChange={e=>setSecondResource(e.target.value)}>{RES.map(r=><option key={r} value={r}>{LABEL[r]}</option>)}</select></label>}<p className="modal-note">不能使用本次个人回合刚买到的发展卡。胜利点卡自动计入你的获胜条件。</p><button className="gold-button" disabled={busy||!legal.developmentCards?.includes(devCard.id)} onClick={()=>act({type:'playDevelopment',cardId:devCard.id,resource:give,resources:[give,secondResource].slice(0,game?.options?.infiniteBank?2:Math.min(2,total(game?.bank)))})}>打出此牌</button></>}
   {modal==='rules'&&<><span className="eyebrow">THE EXPLORER’S HANDBOOK</span><h2>岛屿生存手册</h2><div className="modal-tabs">{[['basics','经典规则'],['extension','5–6 人扩展'],['details','细则与来源']].map(([k,v])=><button className={rulesTab===k?'selected':''} onClick={()=>setRulesTab(k)} key={k}>{v}</button>)}</div><div className="rules-content">{rulesTab==='basics'?<><h3>01 · 从两座村庄开始</h3><p>3–4 人使用 19 块地形。按顺序放一村一路，再逆序放第二村一路。村庄之间至少隔一个空交点；第二座村庄相邻地形各给一张资源。</p><h3>02 · 掷骰、交易、建造</h3><p>两骰之和对应地形产出：村庄得 1 张，城市得 2 张。强盗所在格不产出。完成掷骰后可任意交错交易和建造。</p><div className="rules-costs"><p>道路 <b>木材 + 砖块</b></p><p>村庄 <b>木材 + 砖块 + 羊毛 + 麦子</b></p><p>城市 <b>2 麦子 + 3 矿石</b></p><p>发展卡 <b>羊毛 + 麦子 + 矿石</b></p></div><h3>03 · 交易与强盗</h3><p>银行 4:1，通用港 3:1，专门港对应资源 2:1。只可与当前玩家交易，不能赠送、交易发展卡或用同类资源相互交换。掷出 7 时，超过 7 张资源的人弃掉一半（向下取整），随后移动强盗并随机偷取相邻对手一张资源。</p><h3>04 · 达到 10 分</h3><p>村庄 1 分、城市 2 分；最长道路、最大骑士各 2 分。胜利点发展卡每张 1 分。在自己的回合达到 10 分即获胜。</p></>:rulesTab==='extension'?<><h3>30 块地形，更广阔的航程</h3><p>5–6 人增加地形与资源，资源银行每种 24 张，发展卡共 34 张。每人仍有 15 路、5 村、4 城。</p><h3>现行官方 · 配对玩家回合</h3><p>P1 正常掷骰、交易及建造。随后坐在 P1 左侧第 3 位的 P2 行动：可与银行/港口交易、建造、买牌和打发展卡，但不能与玩家交易，也不再次掷骰。</p><p>两人各有自己的发展卡使用额度，都可在个人行动阶段达到 10 分获胜。P2 结束后，P1 标记向左移动一人。</p><h3>历史官方 · 特殊建造阶段</h3><p>选择此旧版模式时，当前玩家结束后，其余玩家顺序仅能建造、购买发展卡。不能交易、打发展卡或在这一阶段获胜。这个模式已被新版配对回合替代。</p></>:<><h3>发展卡与奖励</h3><p>每个个人回合最多打 1 张非胜利点发展卡，不能打刚买的卡；允许掷骰前打。骑士移动强盗但不弃牌；修路免费修两路；丰收取两张银行资源；垄断获得对手所有指定资源。</p><p>最长道路至少 5 段，可以形成环但不重复计算同一条路，对手建筑截断。并列时原持有人保留；无人拥有且并列则暂时无人持有。最大骑士至少 3 张，须严格超过原持有人。</p><h3>房间自定义规则</h3><p>可选无限银行、自由掷骰时机、允许赠牌、弃牌向上取整。自由掷骰模式仍须在结束个人主回合前掷一次，不能重复掷骰；赠牌仍需要双方确认。开局前由房主设置。开局后可在桌面设置提出修改可选规则，经全员同意后生效，已完成的操作和已确定的弃牌数量不变。</p><p>可选规则还包括“允许撤销建造”和“通用港口混合兑换”。前者允许在交易、掷骰、出牌或结束回合等后续操作前撤销连续建造；后者允许拥有通用 3:1 港口的玩家用任意三张资源兑换。两者都是本项目的可选便捷或趣味规则。</p><h3>库存与隐藏信息</h3><p>资源不足以供给多位玩家时，该种资源都不发；仅一位应得则领取剩余资源。资源类型、未用发展卡及隐藏胜利点对对手隐藏。胜利点卡可刚买即触发获胜。</p><h3>官方规则原文</h3><a target="_blank" rel="noreferrer" href="https://www.catan.com/understand-catan/game-rules">CATAN 官方规则索引 ↗</a><a target="_blank" rel="noreferrer" href="https://www.catan.com/sites/default/files/2025-03/CN3082%20CATAN%20%E2%80%93%205-6%20Rulebook%202025%20reduced.pdf">2025 年 5–6 人扩展规则 ↗</a><a target="_blank" rel="noreferrer" href="https://www.catan.com/faq/basegame">官方经典版常见问题 ↗</a><p className="modal-note">本项目为独立制作的规则实现，并非 CATAN 官方产品。当前范围为经典基础游戏与 5–6 人人数扩展，不包含航海家、城市与骑士等独立内容扩展。</p></>}</div></>}
   {modal==='credits'&&<><h2>素材与随机来源</h2><p>资源图标由 Lorc 与 Delapouite 创作，来自 Game-icons.net，采用 CC BY 3.0 授权。骰子、纸牌和棋子音效为本项目原创合成。岛屿、卡框和界面为本项目绘制。</p><a href="/assets/credits.md" target="_blank">完整素材来源 ↗</a><h3>正式联机骰子</h3><p>由服务端请求 RANDOM.ORG 大气噪声随机整数，每次两枚独立六面骰。来源不可用时停止本次投掷并显示错误；不会静默切换随机源。</p><a href="https://www.random.org/clients/http/api/" target="_blank" rel="noreferrer">RANDOM.ORG 随机来源说明 ↗</a><p className="modal-note">本机练习使用浏览器安全随机，不宣称物理真随机。</p></>}
  </section></div>}
 </>
}

function Terrain({resource:r,x,y}:{resource:string,x:number,y:number}){return <g transform={`translate(${x},${y})`} className="terrain-art">{r==='wood'?<>{[-28,0,28].map((p,i)=><g key={i} transform={`translate(${p},${i===1?-25:-9})`}><path d="M-18 10L0 -28L18 10H11L22 22H-22L-11 10Z" fill={i===1?'#295840':'#326448'}/><path d="M0 -28V22H22L11 10H18Z" fill="#244a38" opacity=".5"/><path d="M-3 22H3V30H-3Z" fill="#6a6944"/></g>)}</>:r==='ore'?<><path d="M-53 20L-16 -36L10 7L30 -20L55 22Z" fill="#647b80"/><path d="M-16 -36L-3 -17L-13 -20L-23 -12L-29 -16Z" fill="#d5ddce"/><path d="M-16 -36L-11 20H10Z" fill="#516971"/><path d="M30 -20L43 22H55Z" fill="#73878a"/></>:r==='brick'?<><path d="M-55 10Q-30 -30-6 -15Q17 -49 47 -3L56 24H-51Z" fill="#a86342"/><path d="M-50 12L-18 -5L10 1L44 -12" stroke="#d29262" strokeWidth="5" fill="none"/><path d="M-47 25L-8 9L19 17L50 4" stroke="#ce8858" strokeWidth="5" fill="none"/></>:r==='wheat'?<>{[-38,-19,0,19,38].map((p,i)=><g key={i} transform={`translate(${p},${i%2?0:-12})`}><path d="M0 27V-22" stroke="#9c7c31" strokeWidth="2"/>{[-14,-4,6].map((a,j)=><g key={j}><ellipse cx="-5" cy={a} rx="3" ry="8" transform={`rotate(-35 -5 ${a})`} fill="#f0d58a"/><ellipse cx="5" cy={a} rx="3" ry="8" transform={`rotate(35 5 ${a})`} fill="#e3c56a"/></g>)}</g>)}</>:r==='sheep'?<><path d="M-56 20Q-19 -18 16 14Q32 -2 56 15V32H-56Z" fill="#759650"/>{[-25,24].map((p,i)=><g key={i} transform={`translate(${p},${i?-14:-26})`}><path d="M-9 8V16M8 8V16" stroke="#61634d" strokeWidth="3"/><ellipse rx="16" ry="11" fill="#f1efcf"/><circle cx="-11" cy="-3" r="8" fill="#f1efcf"/><ellipse cx="16" cy="2" rx="6" ry="8" fill="#5b6753"/></g>)}</>:<><path d="M-53 12Q-18 -25 19 10Q43 0 57 19L47 35H-42Z" fill="#c2aa77"/><path d="M-48 17Q-10 -3 29 17" stroke="#eddbb0" strokeWidth="3" fill="none"/></>}</g>}
